# mcp-apps-harness

Render real, built [ext-apps](https://github.com/modelcontextprotocol/ext-apps) HTML
panels against a mock MCP host, so you can iterate on a panel's UI — DOM, screenshots,
console errors, mocked tool calls — without a real host or MCP server in the loop.

[`@overdraft-protocol/mcp-apps-harness`](https://www.npmjs.com/package/@overdraft-protocol/mcp-apps-harness) on npm · MIT licensed

```
edit panel -> build -> render_panel({ panelPath, fixture }) -> read DOM/errors/screenshot -> iterate
```

## Quick start (Claude Code)

```bash
npx playwright install chromium   # one-time: the default runner drives a real browser
claude mcp add mcp-apps-harness -- npx -y --package=@overdraft-protocol/mcp-apps-harness mcp-apps-harness-mcp
```

Then just ask Claude, e.g. *"render dist/repos.html with this fixture and show me the
screenshot"* or *"click the Save button and mock repos_set returning success, then
check for console errors."* See [Using it with Claude](#using-it-with-claude) for
Claude Desktop setup, global registration, and running from a local checkout instead
of npm.

## MCP tools

- **`render_panel`** `({ panelPath | html | panelUrl | panel, fixture, capabilities?, mode?, viewport?, runner? })` —
  load a panel, push `fixture` as the initial tool result, capture DOM + screenshot +
  console errors/uncaught exceptions + any tool calls the panel attempted with no
  mocked response configured.
- **`interact`** `({ ...same as above, steps })` — same, then replays a sequence of
  `{ action: { type: "click"|"fill", selector }, respondWith?: { tool, result } }`
  steps. `respondWith` queues the mocked `tools/call` response the mock host returns
  when that action triggers `app.callServerTool(...)` (e.g. a Save button).

`render_panel` is `interact` with no `steps` — same code path underneath. Provide
exactly one panel source:

| Source | What it does |
| --- | --- |
| `panelPath` | Read a built HTML file off disk. |
| `html` | The built HTML content, inline. |
| `panelUrl` | Fetch the built HTML from a URL, e.g. a running dev server (`http://localhost:5173/repos.html`). Needs no filesystem access — see [Filesystem access](#filesystem-access-on-macos). |
| `panel` | Look the name up in `.mcp-apps-harness.json` (may resolve to either of the above) — see [Project config](#project-config). |

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

`render_panel({ panel: "repos", fixture })` runs `buildCommand` (if present) and
resolves `path` relative to the config file's directory before rendering — so your
edit/build/render loop becomes one call instead of three. A `url` entry (like
`repos-dev`) is fetched instead of read off disk.

## Filesystem access (on macOS)

`~/Documents`, `~/Desktop`, and `~/Downloads` are TCC-protected: if the app that
spawned this server (e.g. Claude Desktop) was denied access to one of those folders,
`panelPath`/`panel` reads from there fail with `EPERM` — even for files you can read
yourself, since the OS grants access to the responsible app, not to this server. The
error message explains the cause and your options when this happens.

If you'd rather not grant that access, use `panelUrl` instead: point it at any local
dev server (`vite`, `python -m http.server`, whatever you already run). Loopback HTTP
isn't subject to the same restriction, so this needs no filesystem grant at all.

## CLI

For use outside an MCP client (shell scripts, CI, quick manual checks):

```bash
npx -y --package=@overdraft-protocol/mcp-apps-harness mcp-apps-harness render \
  --panel-path dist/repos.html --fixture @fixture.json --out screenshot.png

mcp-apps-harness render --panel repos --cwd . --fixture '{"repos":[]}' --mode dom
mcp-apps-harness render --help
```

`--fixture`, `--steps`, `--capabilities`, and `--tool-args` accept either inline JSON
or `@path/to/file.json`. `--out` writes the screenshot to disk; `--json` prints the
full result (DOM, console messages, errors, unmapped tool calls, open-link attempts,
and the base64 screenshot) instead of the human-readable summary.

### capture-fixture

Capture a real tool result from an actual MCP server as a fixture, instead of
hand-writing one:

```bash
mcp-apps-harness capture-fixture \
  --command node --arg path/to/server.js \
  --tool get_repos --tool-args '{"owner":"anthropics"}' \
  --out fixtures/repos.json
```

Spawns the server over stdio (`--command`/`--arg`), calls `--tool`, and writes its
`structuredContent` to `--out` (or the full `CallToolResult` with `--full`) — ready to
feed straight into `render_panel`'s `fixture`.

## Using it with Claude

This is a **stdio** MCP server, so it works anywhere Claude reads an MCP server
config: Claude Code (CLI, VS Code/JetBrains extensions) and Claude Desktop. It does
**not** work as a Claude.ai web "custom connector" — those require a remote (HTTP/SSE)
server, which this package doesn't provide.

**Prerequisites:** Node 20+, and (for the default Chromium runner) a one-time
`npx playwright install chromium`. Skip the browser install if you only ever use
`runner: "jsdom"`.

### Claude Code

```bash
claude mcp add mcp-apps-harness -- npx -y --package=@overdraft-protocol/mcp-apps-harness mcp-apps-harness-mcp
```

Add `-s user` to register it globally instead of just the current project. Or write
`.mcp.json` by hand:

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

Approve the server when Claude Code prompts you, then `render_panel` and `interact`
show up as tools. Run `/mcp` to confirm it's connected.

### Claude Desktop

Add the same `mcpServers` block above to `claude_desktop_config.json` (Settings →
Developer → Edit Config, or `~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS / `%APPDATA%\Claude\claude_desktop_config.json` on Windows), then restart
Claude Desktop.

### Local checkout instead of npm

Developing the harness itself? Point at your local build instead:

```json
{
  "mcpServers": {
    "mcp-apps-harness": { "command": "node", "args": ["/absolute/path/to/mcp-apps-harness/dist/mcp-server.js"] }
  }
}
```

(Run `npm install && npm run build` in the checkout first.)

<details>
<summary>Why the npx invocation needs <code>--package=…</code> and the <code>-mcp</code> suffix</summary>

The package ships two binaries: `mcp-apps-harness-mcp` (the MCP server) and
`mcp-apps-harness` (the CLI). Because the package name is scoped
(`@overdraft-protocol/…`), `npx`'s default bin-name matching resolves the bare
package to `mcp-apps-harness` — the CLI, not the server. Naming the server's bin
explicitly, with `--package` telling npx which package it lives in, is what actually
points Claude at the server. `-y` skips npx's install-confirmation prompt, needed
since Claude runs it non-interactively.

</details>

## How it works

Panels built with `@modelcontextprotocol/ext-apps`'s `App` class talk to their host
over `postMessage`: `App.connect()` sends `ui/initialize`, the host replies with
capabilities + context, the app sends `ui/notifications/initialized`, and the host
pushes the first `ui/notifications/tool-result` to trigger the panel's render. From
then on, `app.callServerTool(...)` proxies `tools/call` through the host.

This harness implements the **host** side of that protocol as a pure, self-contained
reducer (`handleHostMessage`, in `src/mock-host.ts`), plus two runners that share it:

- **Chromium** (default, always works) — loads the panel's real HTML into an iframe
  inside a Playwright page and drives everything through real `postMessage`/DOM/JS.
  Produces real screenshots.
- **jsdom** (fast path, no screenshots) — runs the reducer directly in the same Node
  process, no browser needed. Works for panels built as a classic (non-module)
  script; see [Known limitations](#known-limitations) for what it can't do. See
  `src/runner-jsdom.ts` for the (nontrivial) implementation notes if you're curious
  why it doesn't just use an iframe like the Chromium runner does.

## Known limitations

- Only `ui/initialize`, `ui/notifications/initialized`, `ui/notifications/tool-result`
  (push), `tools/call`, and `ui/open-link` are modeled with real behavior. Other
  request methods (`ui/download-file`, `ui/message`, `ui/update-model-context`,
  `ui/request-display-mode`, `resources/*`, `sampling/createMessage`) get a generic
  empty-result acknowledgement so the app's promise resolves instead of hanging.
- The Chromium runner's panel iframe isn't sandboxed (no `sandbox` attribute, no
  dedicated origin) — this simplifies same-origin DOM access but doesn't verify a
  panel's behavior under the CSP/sandbox restrictions a real host would apply.
- jsdom cannot execute `<script type="module">` (a jsdom limitation, not specific to
  this harness) and has no real layout engine, so it can't produce screenshots and
  auto-resize is a no-op there. Use the Chromium runner for module-script bundles or
  when you need a screenshot.
- `panelUrl` has no timeout and no custom-header support — a hanging or
  auth-protected remote server will hang the render or fail with 401/403.

## Library usage

```ts
import { renderPanel, interact } from "@overdraft-protocol/mcp-apps-harness";

const result = await renderPanel({
  panelPath: "dist/repos.html",
  fixture: { repos: [{ id: "1", name: "overdraft", starred: true }] },
});
// result.dom, result.screenshot (base64 PNG), result.errors, result.unmappedToolCalls
```

## Development

```bash
git clone https://github.com/overdraft-protocol/mcp-apps-harness.git
cd mcp-apps-harness
npm install
npm run selftest
```

`npm run selftest` builds the harness and a tiny real ext-apps panel (`example/`,
built with the actual `App` API), then runs it end to end: a real `App.connect()`
handshake, mocked `tools/call` responses flowing back through `callServerTool`,
capability gating, `panelUrl`/project-config resolution, and the CLI — against both
the Chromium and jsdom runners.
