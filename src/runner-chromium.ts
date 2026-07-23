/**
 * Chromium runner: loads real built HTML into an iframe inside a Playwright
 * page, mounts the mock host in the page's top-level context (postMessage only
 * works between real Window objects in the same page), drives the handshake +
 * optional interact steps, and captures DOM/screenshot/console/errors.
 *
 * This is the default, always-works path (see runner-jsdom.ts for the caveats
 * of the fast path).
 */
import { chromium } from "playwright";
import { buildBrowserHostScript, createMockHostState } from "./mock-host.js";
import {
  CapturedError,
  ConsoleMessage,
  DEFAULT_VIEWPORT,
  HarnessCapabilities,
  InteractStep,
  RenderResult,
  Viewport,
  stripScriptBodies,
} from "./protocol.js";

const IFRAME_ID = "panel";

export interface ChromiumRenderOptions {
  html: string;
  fixture: unknown;
  capabilities?: HarnessCapabilities;
  viewport?: Viewport;
  steps?: InteractStep[];
  mode?: "dom" | "screenshot" | "both";
  /** Return `<script>` bodies verbatim instead of eliding them. Default false. */
  includeScripts?: boolean;
}

export async function renderWithChromium(options: ChromiumRenderOptions): Promise<RenderResult> {
  // Field-by-field, not `{ ...DEFAULT_VIEWPORT, ...options.viewport }`: callers
  // (e.g. the CLI, which always builds a full { width, height, theme } object)
  // may pass an explicit `undefined` for an unset field, and a plain object
  // spread lets that clobber the default instead of falling through to it.
  const viewport = {
    width: options.viewport?.width ?? DEFAULT_VIEWPORT.width,
    height: options.viewport?.height ?? DEFAULT_VIEWPORT.height,
    theme: options.viewport?.theme ?? DEFAULT_VIEWPORT.theme,
  };
  const mode = options.mode ?? "both";
  const state = createMockHostState({
    fixture: options.fixture,
    capabilities: options.capabilities,
    theme: viewport.theme,
  });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
    });
    await page.emulateMedia({ colorScheme: viewport.theme });

    const consoleMessages: ConsoleMessage[] = [];
    const errors: CapturedError[] = [];
    page.on("console", (msg) => {
      consoleMessages.push({ type: msg.type(), text: msg.text() });
      if (msg.type() === "error") errors.push({ message: msg.text() });
    });
    page.on("pageerror", (err) => {
      errors.push({ message: err.message, stack: err.stack });
    });

    // Not sandboxed: this trades sandbox/CSP-enforcement fidelity for a much
    // simpler same-origin setup (contentDocument readable, no proxy origin
    // needed). Protocol behavior (postMessage handshake, tool calls) is
    // unaffected by iframe sandboxing, which is what this harness verifies.
    await page.setContent(
      `<!doctype html><html><head><style>html,body{margin:0;padding:0;height:100%;}iframe{border:0;width:100%;height:100%;display:block;}</style></head><body><iframe id="${IFRAME_ID}"></iframe></body></html>`,
      { waitUntil: "load" },
    );

    // Attach the mock host's message listener BEFORE the panel's script has any
    // chance to run: the panel sends `ui/initialize` as soon as its script
    // loads, and same-origin srcdoc navigation preserves the iframe's
    // `contentWindow` WindowProxy identity, so capturing it now and setting
    // `srcdoc` afterwards can't race-lose the app's first message.
    await page.evaluate(buildBrowserHostScript(state, IFRAME_ID));

    await page.evaluate(
      ({ html, iframeId }) => {
        const iframe = document.getElementById(iframeId) as HTMLIFrameElement;
        iframe.srcdoc = html;
      },
      { html: options.html, iframeId: IFRAME_ID },
    );

    await page.waitForFunction(() => Boolean((window as any).__mockHostState?.initialized), null, {
      timeout: 10_000,
    });

    // Let the panel finish its first render pass off the tool-result push.
    await page.waitForTimeout(150);

    const frame = page.frameLocator(`#${IFRAME_ID}`);
    for (const step of options.steps ?? []) {
      if (step.respondWith) {
        await page.evaluate(
          ({ tool, result }) => (window as any).__mockHostPushToolResponse(tool, result),
          step.respondWith,
        );
      }
      const locator = frame.locator(step.action.selector);
      if (step.action.type === "click") {
        await locator.click();
      } else {
        await locator.fill(step.action.value ?? "");
      }
      if (step.respondWith) {
        await page.waitForTimeout(150);
      }
    }

    const dom = await page.evaluate((iframeId) => {
      const iframe = document.getElementById(iframeId) as HTMLIFrameElement;
      return iframe.contentDocument?.documentElement.outerHTML ?? "";
    }, IFRAME_ID);

    let screenshot: string | undefined;
    if (mode !== "dom") {
      const buffer = await page.locator(`#${IFRAME_ID}`).screenshot();
      screenshot = buffer.toString("base64");
    }

    const log = await page.evaluate(() => (window as any).__mockHostState.log);

    return {
      dom: mode === "screenshot" ? "" : options.includeScripts ? dom : stripScriptBodies(dom),
      screenshot,
      consoleMessages,
      errors,
      unmappedToolCalls: log.unmappedToolCalls,
      openLinkAttempts: log.openLinkAttempts,
    };
  } finally {
    await browser.close();
  }
}
