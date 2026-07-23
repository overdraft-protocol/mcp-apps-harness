/**
 * Public orchestration: renderPanel({ html|panelPath|panel, fixture,
 * capabilities, steps, mode, viewport }). `render_panel` is just `interact`
 * with no steps — one code path, two MCP tools for clarity (see mcp-server.ts).
 */
import { readFile } from "node:fs/promises";
import { renderWithChromium } from "./runner-chromium.js";
import { renderWithJsdom } from "./runner-jsdom.js";
import { resolvePanelPath } from "./config.js";
import { HarnessCapabilities, InteractStep, RenderResult, Viewport } from "./protocol.js";

export type RenderMode = "dom" | "screenshot" | "both";
export type Runner = "chromium" | "jsdom";

export interface RenderPanelOptions {
  /** Built single-file HTML to load. Provide exactly one of `html`, `panelPath`, `panel`. */
  html?: string;
  /** Path to a built single-file HTML file. Provide exactly one of `html`, `panelPath`, `panel`. */
  panelPath?: string;
  /**
   * Panel name looked up in `.mcp-apps-harness.json`'s `panels` map. If that
   * entry has a `buildCommand`, it's run first. Provide exactly one of
   * `html`, `panelPath`, `panel`.
   */
  panel?: string;
  /** Directory to look for `.mcp-apps-harness.json` in, when using `panel`. Default `process.cwd()`. */
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
  const sources = [options.html, options.panelPath, options.panel].filter((v) => v !== undefined);
  if (sources.length !== 1) {
    throw new Error("mcp-apps-harness: renderPanel requires exactly one of `html`, `panelPath`, or `panel`");
  }

  const panelPath = options.panel ? await resolvePanelPath(options.panel, options.cwd) : options.panelPath;
  const html = options.html ?? (await readFile(panelPath as string, "utf-8"));
  const runner = options.runner ?? "chromium";

  if (runner === "jsdom") {
    if (options.mode === "screenshot" || options.mode === "both") {
      throw new Error(
        'mcp-apps-harness: runner "jsdom" cannot capture screenshots — pass mode: "dom", or omit `runner` to use Chromium',
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

export type InteractOptions = RenderPanelOptions & { steps: InteractStep[] };

/** Alias kept for call-site clarity — identical to `renderPanel` with `steps` set. */
export async function interact(options: InteractOptions): Promise<RenderResult> {
  return renderPanel(options);
}
