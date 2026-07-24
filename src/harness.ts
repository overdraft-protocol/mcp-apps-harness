/**
 * Public orchestration: renderPanel({ html|panelPath|panelUrl|panel, fixture,
 * capabilities, steps, mode, viewport }). `render_panel` is just `interact`
 * with no steps — one code path, two MCP tools for clarity (see mcp-server.ts).
 */
import { readFile } from "node:fs/promises";
import { renderWithChromium } from "./runner-chromium.js";
import { renderWithJsdom } from "./runner-jsdom.js";
import { resolvePanel } from "./config.js";
import { HarnessCapabilities, InteractStep, RenderResult, Viewport } from "./protocol.js";

export type RenderMode = "dom" | "screenshot" | "both";
export type Runner = "chromium" | "jsdom";

export interface RenderPanelOptions {
  /** Built single-file HTML to load. Provide exactly one panel source. */
  html?: string;
  /** Path to a built single-file HTML file. Provide exactly one panel source. */
  panelPath?: string;
  /**
   * URL to fetch the built panel HTML from, e.g. a running dev server
   * (`http://localhost:5173/repos.html`).
   *
   * Useful when the process running this harness can't read the panel off
   * disk — most notably on macOS, where an MCP server spawned by a host app
   * that was denied Documents/Desktop/Downloads access gets EPERM on those
   * paths. Loopback HTTP isn't gated the same way, so serving the panel from
   * a dev server sidesteps the filesystem entirely.
   *
   * Provide exactly one panel source.
   */
  panelUrl?: string;
  /**
   * Panel name looked up in `.inspect-tools.json`'s `panels` map. The entry
   * may specify `path` or `url`; if it has a `buildCommand`, that runs first.
   * Provide exactly one panel source.
   */
  panel?: string;
  /** Directory to look for `.inspect-tools.json` in, when using `panel`. Default `process.cwd()`. */
  cwd?: string;
  /** The `structuredContent` (or full CallToolResult) to push once the panel connects. */
  fixture: unknown;
  /** Host capabilities to advertise. Defaults: serverTools+openLinks on, downloadFile off. */
  capabilities?: HarnessCapabilities;
  /** Click/fill steps to replay after the initial render, e.g. Save -> tools/call -> re-render. */
  steps?: InteractStep[];
  /** What to capture. Default "both". */
  mode?: RenderMode;
  viewport?: Viewport;
  /**
   * Which runner to use. "chromium" (default) always works and produces real
   * screenshots. "jsdom" is a faster, browser-less path for panels built as a
   * classic (non-module) script; it cannot capture screenshots, so `mode`
   * must be "dom" when using it.
   */
  runner?: Runner;
  /**
   * Return `<script>` bodies verbatim. Default false — panels are single-file
   * builds with the whole bundle inlined, so the raw DOM is mostly build input
   * rather than render output.
   */
  includeScripts?: boolean;
}

export async function renderPanel(options: RenderPanelOptions): Promise<RenderResult> {
  const sources = [options.html, options.panelPath, options.panelUrl, options.panel].filter(
    (v) => v !== undefined,
  );
  if (sources.length !== 1) {
    throw new Error(
      "inspect-tools: renderPanel requires exactly one of `html`, `panelPath`, `panelUrl`, or `panel`",
    );
  }

  const html = await loadPanelHtml(options);
  const runner = options.runner ?? "chromium";

  if (runner === "jsdom") {
    if (options.mode === "screenshot" || options.mode === "both") {
      throw new Error(
        'inspect-tools: runner "jsdom" cannot capture screenshots — pass mode: "dom", or omit `runner` to use Chromium',
      );
    }
    return renderWithJsdom({
      html,
      fixture: options.fixture,
      capabilities: options.capabilities,
      theme: options.viewport?.theme,
      steps: options.steps,
      includeScripts: options.includeScripts,
    });
  }

  return renderWithChromium({
    html,
    fixture: options.fixture,
    capabilities: options.capabilities,
    viewport: options.viewport,
    steps: options.steps,
    mode: options.mode,
    includeScripts: options.includeScripts,
  });
}

/**
 * Resolve whichever panel source the caller supplied down to an HTML string.
 *
 * A `panel` name may resolve to either a path or a URL depending on how the
 * project's `.inspect-tools.json` declares it.
 */
async function loadPanelHtml(options: RenderPanelOptions): Promise<string> {
  if (options.html !== undefined) return options.html;
  if (options.panelUrl !== undefined) return fetchPanelHtml(options.panelUrl);

  if (options.panel !== undefined) {
    // One resolve call only — it may run the entry's buildCommand.
    const resolved = await resolvePanel(options.panel, options.cwd);
    return resolved.kind === "url" ? fetchPanelHtml(resolved.url) : readPanelFile(resolved.path);
  }

  return readPanelFile(options.panelPath as string);
}

async function fetchPanelHtml(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error(
      `inspect-tools: could not fetch panel from ${url} (${(err as Error).message}) — is the dev server running?`,
    );
  }
  if (!response.ok) {
    throw new Error(`inspect-tools: fetching panel from ${url} returned HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function readPanelFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" && process.platform === "darwin") {
      throw new Error(
        `inspect-tools: permission denied reading ${path}.\n` +
          "On macOS, ~/Documents, ~/Desktop and ~/Downloads are protected: a process whose parent app was denied access to that folder gets EPERM even though the file is readable by you. Either:\n" +
          "  - serve the panel from a dev server and pass `panelUrl` instead (no filesystem access needed), or\n" +
          "  - grant the host app access under System Settings > Privacy & Security > Files and Folders, or\n" +
          "  - keep the panel outside those protected folders.",
      );
    }
    throw err;
  }
}

export type InteractOptions = RenderPanelOptions & { steps: InteractStep[] };

/** Alias kept for call-site clarity — identical to `renderPanel` with `steps` set. */
export async function interact(options: InteractOptions): Promise<RenderResult> {
  return renderPanel(options);
}
