#!/usr/bin/env node
/**
 * Stdio MCP server exposing `render_panel` and `interact`.
 *
 * `render_panel` is `interact` with no `steps` — see harness.ts. Two tools
 * exist only because "render this panel" and "click through this flow" read
 * more clearly as separate entry points to a caller.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { renderPanel } from "./harness.js";
import { RenderResult } from "./protocol.js";

const capabilitiesShape = {
  serverTools: z.boolean().optional().describe("Advertise ui/notifications/tool-result server-tool proxying. Default true."),
  openLinks: z.boolean().optional().describe("Advertise ui/open-link support. Default true."),
  downloadFile: z.boolean().optional().describe("Advertise ui/download-file support. Default false."),
};

const viewportShape = {
  width: z.number().int().positive().optional().describe("Viewport width in px. Default 1024."),
  height: z.number().int().positive().optional().describe("Viewport height in px. Default 768."),
  theme: z.enum(["light", "dark"]).optional().describe("Color scheme. Default light."),
};

const stepShape = z.object({
  action: z.object({
    type: z.enum(["click", "fill"]),
    selector: z.string().describe("CSS selector, resolved inside the panel's document."),
    value: z.string().optional().describe("Text to enter. Required for type: fill."),
  }),
  respondWith: z
    .object({
      tool: z.string().describe("Tool name the app is expected to call via app.callServerTool(...)."),
      result: z.record(z.string(), z.unknown()).describe("The CallToolResult-shaped mock response."),
    })
    .optional()
    .describe("Queue a mocked tools/call response the mock host returns for this step's action."),
});

const baseShape = {
  panelPath: z.string().optional().describe("Path to a built single-file HTML panel. Provide exactly one of panelPath, html, panelUrl, panel."),
  html: z.string().optional().describe("Built single-file HTML content. Provide exactly one of panelPath, html, panelUrl, panel."),
  panelUrl: z
    .string()
    .optional()
    .describe(
      "URL to fetch the built panel HTML from, e.g. a running dev server (http://localhost:5173/repos.html). Needs no filesystem access, so it works when this server can't read the project directory. Provide exactly one of panelPath, html, panelUrl, panel.",
    ),
  panel: z
    .string()
    .optional()
    .describe(
      "Panel name looked up in .mcp-apps-harness.json's `panels` map (runs its buildCommand first, if any). Provide exactly one of panelPath, html, panelUrl, panel.",
    ),
  cwd: z.string().optional().describe("Directory to look for .mcp-apps-harness.json in, when using `panel`. Default process.cwd()."),
  fixture: z.record(z.string(), z.unknown()).describe("structuredContent (or a full CallToolResult) pushed once the panel connects."),
  capabilities: z.object(capabilitiesShape).optional(),
  mode: z.enum(["dom", "screenshot", "both"]).optional().describe("What to capture. Default both."),
  viewport: z.object(viewportShape).optional(),
  includeScripts: z
    .boolean()
    .optional()
    .describe(
      "Return <script> bodies verbatim in the DOM. Default false — single-file panel builds inline the whole bundle, which is build input rather than render output and swamps the response.",
    ),
  runner: z
    .enum(["chromium", "jsdom"])
    .optional()
    .describe(
      'Default "chromium" (always works, real screenshots). "jsdom" is a faster, browser-less path for classic-script (non-module) panel bundles; requires mode: "dom".',
    ),
};

function toToolResponse(result: RenderResult) {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  > = [];

  if (result.dom) {
    content.push({ type: "text", text: `DOM:\n${result.dom}` });
  }
  if (result.errors.length > 0) {
    const summary = result.errors.map((e) => `- ${e.message}${e.stack ? `\n${e.stack}` : ""}`).join("\n");
    content.push({ type: "text", text: `Console errors / uncaught exceptions:\n${summary}` });
  }
  if (result.unmappedToolCalls.length > 0) {
    const summary = result.unmappedToolCalls
      .map((c) => `- ${c.name}(${JSON.stringify(c.arguments)})`)
      .join("\n");
    content.push({
      type: "text",
      text: `Tool calls the panel attempted with no mocked response configured:\n${summary}`,
    });
  }
  if (result.screenshot) {
    content.push({ type: "image", data: result.screenshot, mimeType: "image/png" });
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "(no DOM or screenshot captured)" });
  }

  return {
    content,
    structuredContent: {
      dom: result.dom,
      consoleMessages: result.consoleMessages,
      errors: result.errors,
      unmappedToolCalls: result.unmappedToolCalls,
      openLinkAttempts: result.openLinkAttempts,
    },
  };
}

const server = new McpServer({ name: "mcp-apps-harness", version: "0.1.0" });

server.registerTool(
  "render_panel",
  {
    title: "Render an ext-apps panel",
    description:
      "Load a real built ext-apps panel HTML file (or inline HTML) into a mock MCP host, push a fixture as the initial tool result, and capture the resulting DOM/screenshot/console errors.",
    inputSchema: baseShape,
  },
  async (args) => {
    const result = await renderPanel(args);
    return toToolResponse(result);
  },
);

server.registerTool(
  "interact",
  {
    title: "Render an ext-apps panel and replay click/fill steps",
    description:
      "Same as render_panel, then replays a sequence of click/fill actions against the rendered panel. Steps may declare a mocked tools/call response the mock host returns when the panel calls app.callServerTool(...) as a result of that action (e.g. a Save button triggering a re-render).",
    inputSchema: { ...baseShape, steps: z.array(stepShape).describe("Actions to replay in order after the initial render.") },
  },
  async (args) => {
    const result = await renderPanel(args);
    return toToolResponse(result);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
