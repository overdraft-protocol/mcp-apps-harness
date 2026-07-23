/**
 * jsdom runner: the fast path. Runs the panel's own bundle directly inside a
 * JSDOM instance in the SAME Node process — no browser needed.
 *
 * WHY NOT AN IFRAME: the natural design mirrors runner-chromium.ts — a host
 * document with the panel in a nested `<iframe>`. That does NOT work reliably
 * in jsdom (25.x): `iframe.srcdoc` never triggers navigation at all (confirmed
 * empirically — contentDocument stays empty, no script runs), and even the
 * working alternative (`iframe.src = "data:text/html;base64,..."`) breaks
 * `event.source` identity — a `contentWindow` reference captured before
 * navigation (as real hosts do, and as PostMessageTransport's own docs
 * recommend) no longer equals `event.source` on messages from that iframe
 * afterwards, and re-fetching `contentWindow` fresh inside the listener
 * *still* doesn't match. Any transport that validates `event.source` (which
 * `PostMessageTransport` does, and which our shared `handleHostMessage`
 * reducer's Node/browser bindings assume) silently drops every message.
 *
 * Instead, the panel's own window IS this JSDOM instance's top-level window,
 * and `window.parent` is monkey-patched (via jsdom's `beforeParse` hook, so
 * it's in place before the panel's script runs) to a fake host object whose
 * `postMessage` calls the exact same `handleHostMessage` reducer the Chromium
 * runner uses, then dispatches a synthetic `message` MessageEvent back at the
 * panel window with `source` set to that same fake-parent object — which is
 * what `PostMessageTransport`'s `event.source === this.eventSource` check
 * actually needs. No iframe, no cross-frame postMessage, no identity problem.
 *
 * KNOWN LIMITATION: jsdom does not execute `<script type="module">`. If the
 * panel bundle is emitted as ES modules (e.g. some vite-plugin-singlefile
 * configs), this runner will time out waiting for the `ui/initialize`
 * handshake. Prefer a classic-script build target for panels you want to run
 * through this fast path; otherwise use runner-chromium.ts, which always works.
 */
import { JSDOM, VirtualConsole } from "jsdom";
import { createMockHostState, handleHostMessage, queueToolResponse } from "./mock-host.js";
import { CapturedError, ConsoleMessage, HarnessCapabilities, InteractStep, RenderResult, Theme } from "./protocol.js";

export interface JsdomRenderOptions {
  html: string;
  fixture: unknown;
  capabilities?: HarnessCapabilities;
  theme?: Theme;
  steps?: InteractStep[];
}

const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"] as const;

export async function renderWithJsdom(options: JsdomRenderOptions): Promise<RenderResult> {
  const consoleMessages: ConsoleMessage[] = [];
  const errors: CapturedError[] = [];

  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    const detail = (err as Error & { detail?: Error }).detail;
    errors.push({ message: detail?.message ?? err.message, stack: detail?.stack ?? err.stack });
  });
  for (const level of CONSOLE_LEVELS) {
    virtualConsole.on(level, (...args: unknown[]) => {
      const text = args.map((a) => String(a)).join(" ");
      consoleMessages.push({ type: level, text });
      if (level === "error") errors.push({ message: text });
    });
  }

  const state = createMockHostState({
    fixture: options.fixture,
    capabilities: options.capabilities,
    theme: options.theme ?? "light",
  });

  const dom = new JSDOM(options.html, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    url: "https://mcp-apps-harness.local/panel/",
    virtualConsole,
    beforeParse(window) {
      const fakeParent: { postMessage(message: unknown, targetOrigin: string): void } = {
        postMessage(message: unknown) {
          const toSend = handleHostMessage(message, state);
          for (const reply of toSend) {
            queueMicrotask(() => {
              window.dispatchEvent(
                new window.MessageEvent("message", {
                  data: reply,
                  source: fakeParent as unknown as Window,
                }),
              );
            });
          }
        },
      };
      Object.defineProperty(window, "parent", { value: fakeParent, configurable: true });

      // jsdom has no ResizeObserver. App.connect() calls
      // setupSizeChangedNotifications() as its last step whenever autoResize is
      // enabled (the default), which constructs one — with no polyfill that
      // throws a ReferenceError, connect()'s promise rejects, and the panel
      // never gets past its own `.catch()`, even though the actual
      // initialize/initialized/tool-result handshake above it succeeded. A
      // no-op stub is enough: this harness doesn't simulate real layout, so
      // there's nothing meaningful for a real ResizeObserver to report anyway.
      if (typeof (window as unknown as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
        class NoopResizeObserver {
          observe(): void {}
          unobserve(): void {}
          disconnect(): void {}
        }
        (window as unknown as { ResizeObserver: unknown }).ResizeObserver = NoopResizeObserver;
      }
    },
  });

  const { window } = dom;

  try {
    await waitFor(
      () => state.initialized,
      5000,
      'ui/initialize handshake (if the panel bundle uses <script type="module">, jsdom cannot execute it — use the Chromium runner instead)',
    );
    await sleep(50);

    for (const step of options.steps ?? []) {
      if (step.respondWith) {
        queueToolResponse(state, step.respondWith.tool, step.respondWith.result);
      }
      const target = window.document.querySelector(step.action.selector);
      if (!target) {
        throw new Error(`mcp-apps-harness: selector not found in panel: ${step.action.selector}`);
      }
      if (step.action.type === "click") {
        (target as unknown as HTMLElement).click();
      } else {
        (target as unknown as HTMLInputElement).value = step.action.value ?? "";
        target.dispatchEvent(new window.Event("input", { bubbles: true }));
        target.dispatchEvent(new window.Event("change", { bubbles: true }));
      }
      if (step.respondWith) {
        await sleep(50);
      }
    }

    return {
      dom: window.document.documentElement.outerHTML,
      consoleMessages,
      errors,
      unmappedToolCalls: state.log.unmappedToolCalls,
      openLinkAttempts: state.log.openLinkAttempts,
    };
  } finally {
    window.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`mcp-apps-harness: timed out waiting for ${label}`);
    }
    await sleep(20);
  }
}
