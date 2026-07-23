# mcp-apps-harness

Render real, built [ext-apps](https://github.com/modelcontextprotocol/ext-apps) HTML
panels against a mock MCP host, so you can iterate on a panel's UI without a real
host or MCP server in the loop.

Published as [`@overdraft-protocol/mcp-apps-harness`](https://www.npmjs.com/package/@overdraft-protocol/mcp-apps-harness).
To wire it into Claude in one step, jump to [Using it with Claude](#using-it-with-claude).

```
edit panel -> npm run build:ui -> render_panel({ panelPath, fixture }) -> read DOM/errors/screenshot -> iterate
```

## How it works

Panels built with `@modelcontextprotocol/ext-apps`'s `App` class talk to their host
over `postMessage`: `App.connect()` sends `ui/initialize`, the host replies with
capabilities + context, the app sends `ui/notifications/initialized`, and the host
pushes the first `ui/notifications/tool-result` to trigger the panel's render. From
then on, `app.callServerTool(...)` proxies `tools/call` through the host.

This harness implements the **host** side of that protocol (`src/mock-host.ts`) as a
pure, self-contained reducer (`handleHostMessage(msg, state)`), plus two transport
bindings that share it:

- **Chromium** (`src/runner-chromium.ts`, default, always works): loads the panel's
  real HTML into an iframe inside a Playwright page, injects the reducer into the
  page (serialized via `Function.prototype.toString()` so it's byte-identical to the
  Node-side copy), and drives everything through real `postMessage`/DOM/JS. Produces
  real screenshots.
- **jsdom** (`src/runner-jsdom.ts`, fast path, no screenshots): runs the reducer
  directly in the same Node process — no browser needed. Deliberately *not* an
  iframe: jsdom 25's nested-browsing-context support is too unreliable for that
  (`srcdoc` never navigates at all; `src="data:..."` navigates but breaks
  `event.source` identity, which `PostMessageTransport` depends on). Instead the
  panel's bundle runs as the JSDOM instance's own top-level window, with
  `window.parent` monkey-patched to a fake host object that calls the same
  `handleHostMessage` reducer directly — no cross-frame `postMessage` involved.
  jsdom also has no `ResizeObserver`, which `App.connect()` needs for its
  (default-on) auto-resize setup, so a no-op stub is installed before the panel's
  script runs. With both of those handled, this path works for any panel built as
  a classic (non-module) script — see the "Known limitations" section for the one
  real gap that remains (ES modules).

## MCP tools

- `render_panel({ panelPath | html | panelUrl | panel, fixture, capabilities?, mode?, viewport?, runner? })` —
  load a panel, push `fixture` as the initial tool result, capture DOM + screenshot
  + console errors/uncaught exceptions + any tool calls the panel attempted with no
  mocked response configured.
- `interact({ ...same as above, steps })` — same, then replays a sequence of
  `{ action: { type: "click"|"fill", selector }, respondWith?: { tool, result } }`
  steps. `respondWith` queues the mocked `tools/call` response the mock host returns
  when that action triggers `app.callServerTool(...)` (e.g. a Save button).

`render_panel` is `interact` with no `steps` — same code path underneath
(`src/harness.ts`). Provide exactly one panel source:

- `panelPath` — read a built HTML file off disk.
- `html` — the built HTML content, inline.
- `panelUrl` — fetch the built HTML from a URL, e.g. a running dev server
  (`http://localhost:5173/repos.html`). Needs no filesystem access at all — see
  "Filesystem access / EPERM" below for why that matters.
- `panel` — look the name up in a project's `.mcp-apps-harness.json` (may
  resolve to either of the above) — see "Project config" below.

## Project config

Instead of tracking build output paths by hand, add a `.mcp-apps-harness.json` at
your project root:

```json
{
  "panels": {
    "repos": { "path": "src/ui/dist/repos.html", "buildCommand": "npm run build:ui" },
    "repos-dev": { "url": "http://localhost:5173/repos.html" }
  }
}
```

Then `render_panel({ panel: "repos", fixture })` runs `buildCommand` (if present,
in the config file's directory) and resolves `path` relative to that same
directory before rendering — so your edit/build/render loop becomes one call
instead of three. A `url` entry (like `repos-dev` above) is fetched instead of
read off disk, running `buildCommand` first if present there too.

## Filesystem access / EPERM

On macOS, `~/Documents`, `~/Desktop`, and `~/Downloads` are TCC-protected: a
process whose parent app (e.g. Claude Desktop) was denied access to one of
those folders gets `EPERM` reading files there — even files you can read fine
yourself — because the OS attributes the grant to the responsible app, not to
this server specifically. If you don't want to grant a host app that broad an
access, or can't, use `panelUrl` instead of `panelPath`/`panel`: serve the
built panel from any local dev server (`vite`, `python -m http.server`,
whatever you already have) and point `panelUrl` at it. Loopback HTTP isn't
subject to the same gate, so this needs no filesystem grant at all — verified
by spawning the server with a `cwd` outside the project and confirming
`panelUrl` still renders correctly.

`render_panel`/`interact` detect this specific failure (`EPERM` on darwin) and
return an error explaining the cause and all three options — grant access,
switch to `panelUrl`, or move the panel outside the protected folders — rather
than a bare `EPERM: operation not permitted, open '...'`.

## CLI

For use outside an MCP client (shell scripts, CI, quick manual checks):

```bash
mcp-apps-harness render --panel-path dist/repos.html --fixture @fixture.json --out screenshot.png
mcp-apps-harness render --panel repos --cwd . --fixture '{"repos":[]}' --mode dom
mcp-apps-harness render --help
```

`--fixture`, `--steps`, `--capabilities`, and `--tool-args` accept either inline
JSON or `@path/to/file.json`. `--out` writes the screenshot to disk; `--json`
prints the full result (DOM, console messages, errors, unmapped tool calls,
open-link attempts, and the base64 screenshot) instead of the human-readable
summary.

### capture-fixture

Capture a real tool result from an actual MCP server as a fixture, instead of
hand-writing one:

```bash
mcp-apps-harness capture-fixture \
  --command node --arg path/to/server.js \
  --tool get_repos --tool-args '{"owner":"anthropics"}' \
  --out fixtures/repos.json
```

Spawns the server over stdio (`@command @arg...`), calls `--tool`, and writes its
`structuredContent` to `--out` (or the full `CallToolResult` with `--full`) — ready
to feed straight into `render_panel`'s `fixture`.

## Using it with Claude

This is a **stdio** MCP server, so it works anywhere Claude reads an MCP server
config: Claude Code (CLI, VS Code/JetBrains extensions) and Claude Desktop. It
does **not** work as a Claude.ai web "custom connector" — those require a remote
(HTTP/SSE) server, which this package doesn't provide.

### Prerequisites

- **Node 20+** (the CLI uses `node:util`'s `parseArgs`).
- **A Chromium browser for Playwright.** The default runner drives a real
  Chromium, which Playwright downloads separately from npm. One time, run:
  ```bash
  npx playwright install chromium
  ```
  Without it, `render_panel`/`interact` fail with a "browser not found" error the
  first time they run. (If you only ever use `runner: "jsdom"`, you can skip this.)

### Claude Code

The one-liner (adds it to the current project's `.mcp.json`):

```bash
claude mcp add mcp-apps-harness -- npx -y --package=@overdraft-protocol/mcp-apps-harness mcp-apps-harness-mcp
```

Add `-s user` to register it globally for all your projects instead of just the
current one:

```bash
claude mcp add -s user mcp-apps-harness -- npx -y --package=@overdraft-protocol/mcp-apps-harness mcp-apps-harness-mcp
```

Or write the config by hand — create/edit `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "mcp-apps-harness": {
      "command": "npx",
      "args": ["-y", "--package=@overdraft-protocol/mcp-apps-harness", "mcp-apps-harness-mcp"]
    }
  }
}
```

Claude Code prompts you to approve a newly added project MCP server the first time
it starts; approve it, then `render_panel` and `interact` show up as tools. Run
`/mcp` inside Claude Code to confirm the server is connected.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config, or:
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows) and add the same
`mcpServers` block shown above, then fully restart Claude Desktop.

### Why `--package=…` and the exact bin name

The package ships **two** binaries: `mcp-apps-harness-mcp` (the MCP server, which
Claude talks to over stdio) and `mcp-apps-harness` (the human-facing CLI). Because
the package name is scoped (`@overdraft-protocol/…`), `npx`'s default bin-name
matching resolves the bare package to `mcp-apps-harness` (the CLI) — the wrong one
for Claude. Naming `mcp-apps-harness-mcp` explicitly, with `--package` telling npx
which package that bin lives in, is what points Claude at the server.

`-y` skips npx's install confirmation prompt (needed since Claude runs it
non-interactively). npx caches the package after first fetch, so subsequent
launches are fast; to pin a version, use `@overdraft-protocol/mcp-apps-harness@0.1.0`.

### Local checkout instead of npm

If you've cloned this repo and want Claude to run your local build (e.g. while
developing the harness itself), point at the built server directly instead:

```json
{
  "mcpServers": {
    "mcp-apps-harness": { "command": "node", "args": ["/absolute/path/to/mcp-apps-harness/dist/mcp-server.js"] }
  }
}
```

(Run `npm install && npm run build` in the checkout first.)

### Using it once connected

Ask Claude in natural language — e.g. *"render dist/repos.html with this fixture
and show me the screenshot"* or *"click the Save button and mock repos_set
returning success, then check for console errors."* Claude calls `render_panel` /
`interact` with the arguments described under [MCP tools](#mcp-tools) above.

### Standalone CLI (no Claude)

The CLI bin is available from the same package for shell/CI use:

```bash
npx -y --package=@overdraft-protocol/mcp-apps-harness mcp-apps-harness render --help
```

## Self-test

`example/` contains a tiny real ext-apps panel (repo list + Save button, built with
the actual `App` API and bundled via esbuild into a single classic-script HTML file)
used to validate the harness end-to-end:

```bash
npm run selftest
```

This builds the harness, builds the example panel, and runs two suites:

- `example/selftest.mjs` (library API): the fixture renders via a real
  `App.connect()` handshake, a mocked `tools/call` response flows back through
  `callServerTool`, an unmapped tool call is reported when no mock response is
  queued, `getHostCapabilities().serverTools`/`openLinks` gating both work, all
  of the above against both the Chromium and jsdom runners, and `panel` resolution
  through `.mcp-apps-harness.json` (including running its `buildCommand`).
- `example/selftest-cli.mjs` (CLI): `render` writes a real PNG, `--json` +
  `--steps` work, `--panel`/`--cwd` resolve through the project config, and
  `capture-fixture` round-trips a real tool call against `dist/mcp-server.js`.

## Library usage

```ts
import { renderPanel, interact } from "@overdraft-protocol/mcp-apps-harness";

const result = await renderPanel({
  panelPath: "dist/repos.html",
  fixture: { repos: [{ id: "1", name: "overdraft", starred: true }] },
});
// result.dom, result.screenshot (base64 PNG), result.errors, result.unmappedToolCalls
```

## Known limitations (MVP scope)

- Only `ui/initialize`, `ui/notifications/initialized`, `ui/notifications/tool-result`
  (push), `tools/call`, and `ui/open-link` are modeled with real behavior. Other
  request methods (`ui/download-file`, `ui/message`, `ui/update-model-context`,
  `ui/request-display-mode`, `resources/*`, `sampling/createMessage`) get a generic
  empty-result acknowledgement so the app's promise resolves instead of hanging —
  they aren't exercised meaningfully yet.
- The panel iframe (Chromium runner) isn't sandboxed (no `sandbox` attribute, no
  dedicated origin) — this simplifies same-origin DOM access for the harness but
  doesn't verify a panel's behavior under the CSP/sandbox restrictions a real host
  would apply.
- jsdom cannot execute `<script type="module">` — a real jsdom limitation, not
  specific to this harness. If your panel bundle is ES modules (rather than a
  classic IIFE/UMD script), the jsdom runner will time out on the handshake;
  use the Chromium runner for those, or change your panel's build target.
- jsdom has no real layout engine, so `sendSizeChanged`/auto-resize is a no-op
  there (stubbed out — see runner-jsdom.ts) and there's no screenshot support;
  use Chromium (`mode: "screenshot"` or `"both"`) when you need either.
- No jsdom test-helper exports beyond `renderWithJsdom`/`renderPanel({ runner: "jsdom" })`
  themselves — there's no separate Vitest/Jest-specific assertion wrapper.
