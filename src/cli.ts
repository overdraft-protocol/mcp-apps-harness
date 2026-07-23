#!/usr/bin/env node
/**
 * Argv-driven CLI mirroring the `render_panel`/`interact` MCP tools, for use
 * outside an MCP client (shell scripts, CI, quick manual checks). Writes the
 * screenshot to disk instead of returning it inline.
 *
 * Usage:
 *   mcp-apps-harness render --panel-path dist/repos.html --fixture @fixture.json --out screenshot.png
 *   mcp-apps-harness render --panel repos --cwd . --fixture '{"repos":[]}' --mode dom
 *   mcp-apps-harness capture-fixture --command node --arg dist/server.js --tool get_repos --out fixture.json
 *
 * JSON-shaped arguments (--fixture, --steps, --capabilities, --tool-args)
 * accept either inline JSON or `@path/to/file.json`.
 */
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { renderPanel } from "./harness.js";
import { InteractStep, HarnessCapabilities } from "./protocol.js";

async function readJsonArg<T>(value: string | undefined): Promise<T | undefined> {
  if (value === undefined) return undefined;
  const raw = value.startsWith("@") ? await readFile(value.slice(1), "utf-8") : value;
  return JSON.parse(raw) as T;
}

function printUsageAndExit(code: number): never {
  console.error(
    [
      "Usage:",
      "  mcp-apps-harness render --panel-path <file> | --panel-url <url> | --panel <name> --fixture <json|@file> [options]",
      "  mcp-apps-harness capture-fixture --command <cmd> [--arg <a> ...] --tool <name> --out <file> [--tool-args <json|@file>]",
      "",
      "render options:",
      "  --panel-path <file>       Built single-file HTML panel.",
      "  --panel-url <url>         Fetch the built panel HTML from a URL (e.g. a dev server).",
      "  --panel <name>            Panel name from .mcp-apps-harness.json (use with --cwd).",
      "  --cwd <dir>               Directory to resolve .mcp-apps-harness.json in. Default: cwd.",
      "  --fixture <json|@file>    structuredContent pushed once the panel connects. Required.",
      "  --steps <json|@file>      Array of interact steps.",
      "  --capabilities <json|@file>",
      "  --mode <dom|screenshot|both>  Default: both if --out is set, else dom.",
      "  --runner <chromium|jsdom> Default: chromium.",
      "  --viewport-width <n> --viewport-height <n> --theme <light|dark>",
      "  --out <file>              Write the screenshot PNG here.",
      "  --json                    Print the full result (incl. base64 screenshot) as JSON.",
    ].join("\n"),
  );
  process.exit(code);
}

async function runRender(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "panel-path": { type: "string" },
      "panel-url": { type: "string" },
      panel: { type: "string" },
      cwd: { type: "string" },
      fixture: { type: "string" },
      steps: { type: "string" },
      capabilities: { type: "string" },
      mode: { type: "string" },
      runner: { type: "string" },
      "viewport-width": { type: "string" },
      "viewport-height": { type: "string" },
      theme: { type: "string" },
      out: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) printUsageAndExit(0);
  if (!values.fixture) {
    console.error("mcp-apps-harness render: --fixture is required\n");
    printUsageAndExit(1);
  }
  if (!values["panel-path"] && !values.panel && !values["panel-url"]) {
    console.error("mcp-apps-harness render: one of --panel-path, --panel-url or --panel is required\n");
    printUsageAndExit(1);
  }

  const mode = (values.mode as "dom" | "screenshot" | "both" | undefined) ?? (values.out ? "both" : "dom");
  const fixture = await readJsonArg<unknown>(values.fixture);
  const steps = await readJsonArg<InteractStep[]>(values.steps);
  const capabilities = await readJsonArg<HarnessCapabilities>(values.capabilities);

  const result = await renderPanel({
    panelPath: values["panel-path"],
    panelUrl: values["panel-url"],
    panel: values.panel,
    cwd: values.cwd,
    fixture,
    steps,
    capabilities,
    mode,
    runner: values.runner as "chromium" | "jsdom" | undefined,
    viewport: {
      width: values["viewport-width"] ? Number(values["viewport-width"]) : undefined,
      height: values["viewport-height"] ? Number(values["viewport-height"]) : undefined,
      theme: values.theme as "light" | "dark" | undefined,
    },
  });

  if (values.out && result.screenshot) {
    await writeFile(values.out, Buffer.from(result.screenshot, "base64"));
  }

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`DOM: ${result.dom.length} chars`);
  console.log(`Console errors: ${result.errors.length === 0 ? "none" : ""}`);
  for (const e of result.errors) console.log(`  - ${e.message}`);
  console.log(`Unmapped tool calls: ${result.unmappedToolCalls.length === 0 ? "none" : ""}`);
  for (const c of result.unmappedToolCalls) console.log(`  - ${c.name}(${JSON.stringify(c.arguments)})`);
  console.log(`Open-link attempts: ${result.openLinkAttempts.length === 0 ? "none" : ""}`);
  for (const a of result.openLinkAttempts) console.log(`  - ${a.url}`);
  if (values.out && result.screenshot) {
    console.log(`Screenshot written to ${values.out}`);
  }
}

async function runCaptureFixture(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      command: { type: "string" },
      arg: { type: "string", multiple: true, default: [] },
      tool: { type: "string" },
      "tool-args": { type: "string" },
      out: { type: "string" },
      full: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) printUsageAndExit(0);
  if (!values.command || !values.tool || !values.out) {
    console.error("mcp-apps-harness capture-fixture: --command, --tool, and --out are required\n");
    printUsageAndExit(1);
  }

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const toolArgs = (await readJsonArg<Record<string, unknown>>(values["tool-args"])) ?? {};
  const client = new Client({ name: "mcp-apps-harness-capture-fixture", version: "0.1.0" });
  const transport = new StdioClientTransport({ command: values.command, args: values.arg as string[] });

  await client.connect(transport);
  try {
    const result = await client.callTool({ name: values.tool, arguments: toolArgs });
    if (result.isError) {
      console.error(`mcp-apps-harness: tool "${values.tool}" returned an error result:`, result.content);
    }
    const toWrite = values.full ? result : (result.structuredContent ?? {});
    await writeFile(values.out, JSON.stringify(toWrite, null, 2));
    console.log(`Wrote ${values.out}`);
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "render") {
    await runRender(rest);
  } else if (command === "capture-fixture") {
    await runCaptureFixture(rest);
  } else {
    if (command !== undefined && command !== "--help" && command !== "-h") {
      console.error(`mcp-apps-harness: unknown command "${command}"\n`);
    }
    printUsageAndExit(command === "--help" || command === "-h" ? 0 : 1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
