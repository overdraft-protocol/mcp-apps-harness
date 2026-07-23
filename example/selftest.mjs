import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderPanel, interact } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`ok: ${message}`);
  }
}

async function main() {
  const html = await readFile(path.join(__dirname, "dist/panel.html"), "utf-8");
  const fixture = JSON.parse(await readFile(path.join(__dirname, "fixture.json"), "utf-8"));

  // 1. Basic render: fixture should show up in the DOM via the real `App` handshake.
  const rendered = await renderPanel({ html, fixture, mode: "both" });
  assert(rendered.errors.length === 0, `no console errors on initial render (got: ${JSON.stringify(rendered.errors)})`);
  assert(rendered.dom.includes("overdraft"), "DOM contains fixture repo name");
  assert(rendered.dom.includes("mcp-apps-harness"), "DOM contains second fixture repo name");
  assert(typeof rendered.screenshot === "string" && rendered.screenshot.length > 0, "screenshot captured");

  // 2. Interact: click Save with a mocked tools/call response -> panel shows "saved".
  const saved = await interact({
    html,
    fixture,
    steps: [
      {
        action: { type: "click", selector: "#save-btn" },
        respondWith: { tool: "repos_set", result: { content: [{ type: "text", text: "ok" }], isError: false } },
      },
    ],
  });
  assert(saved.errors.length === 0, "no console errors during interact");
  assert(saved.dom.includes('id="status">saved<'), "status shows saved after mocked tools/call response");
  assert(saved.unmappedToolCalls.length === 0, "tool call was mapped, no unmapped calls recorded");

  // 3. Interact with no mocked response queued -> mock host reports an unmapped tool call
  // and the panel surfaces the resulting isError:true.
  const unmapped = await interact({
    html,
    fixture,
    steps: [{ action: { type: "click", selector: "#save-btn" } }],
  });
  assert(unmapped.unmappedToolCalls.length === 1, "unmapped tool call recorded when no mock response queued");
  assert(unmapped.unmappedToolCalls[0]?.name === "repos_set", "unmapped tool call has the expected name");
  assert(unmapped.dom.includes('id="status">save failed<'), "panel surfaces isError:true from the unmapped-call fallback");

  // 4. Capability gating: serverTools:false -> panel must not attempt the call at all.
  const gated = await interact({
    html,
    fixture,
    capabilities: { serverTools: false },
    steps: [{ action: { type: "click", selector: "#save-btn" } }],
  });
  assert(gated.unmappedToolCalls.length === 0, "no tool call attempted when serverTools capability is disabled");
  assert(gated.dom.includes('id="status">server tools unavailable<'), "panel respects getHostCapabilities().serverTools");

  // 5. Capability gating, openLinks branch: enabled -> ui/open-link is accepted
  // and recorded; disabled -> the panel doesn't even attempt the call.
  const linkAllowed = await interact({
    html,
    fixture,
    capabilities: { openLinks: true },
    steps: [{ action: { type: "click", selector: "#docs-btn" } }],
  });
  assert(linkAllowed.dom.includes('id="link-status">link opened<'), "openLinks:true -> ui/open-link accepted");
  assert(
    linkAllowed.openLinkAttempts.length === 1 && linkAllowed.openLinkAttempts[0]?.url === "https://example.com/docs",
    "mock host recorded the open-link attempt with the right URL",
  );

  const linkGated = await interact({
    html,
    fixture,
    capabilities: { openLinks: false },
    steps: [{ action: { type: "click", selector: "#docs-btn" } }],
  });
  assert(linkGated.openLinkAttempts.length === 0, "no ui/open-link attempted when openLinks capability is disabled");
  assert(linkGated.dom.includes('id="link-status">open links unavailable<'), "panel respects getHostCapabilities().openLinks");

  // 6. Same checks again via the jsdom fast path (mode: "dom" required — no screenshots there).
  const jsdomRendered = await renderPanel({ html, fixture, mode: "dom", runner: "jsdom" });
  assert(jsdomRendered.errors.length === 0, `jsdom: no console errors on initial render (got: ${JSON.stringify(jsdomRendered.errors)})`);
  assert(jsdomRendered.dom.includes("overdraft"), "jsdom: DOM contains fixture repo name");

  const jsdomSaved = await interact({
    html,
    fixture,
    mode: "dom",
    runner: "jsdom",
    steps: [
      {
        action: { type: "click", selector: "#save-btn" },
        respondWith: { tool: "repos_set", result: { content: [{ type: "text", text: "ok" }], isError: false } },
      },
    ],
  });
  assert(jsdomSaved.dom.includes('id="status">saved<'), "jsdom: status shows saved after mocked tools/call response");

  // 7. `panel` option: resolve via example/.mcp-apps-harness.json, which points
  // at dist/panel.html with a buildCommand ("node build.mjs"). Delete the built
  // file first so a passing render proves the buildCommand actually ran.
  await rm(path.join(__dirname, "dist/panel.html"), { force: true });
  const viaConfig = await renderPanel({ panel: "repos", cwd: __dirname, fixture, mode: "dom" });
  assert(viaConfig.errors.length === 0, "panel config: no console errors");
  assert(viaConfig.dom.includes("overdraft"), "panel config: buildCommand ran and DOM contains fixture repo name");

  // 8. Script bodies are elided by default (a single-file panel bundle is
  // hundreds of KB of build input that would otherwise swamp the DOM output),
  // but still available on request.
  const rawHtmlSize = html.length;
  assert(rendered.dom.length < rawHtmlSize / 10, `default DOM elides the inlined bundle (${rendered.dom.length} chars vs ${rawHtmlSize} of source HTML)`);
  assert(rendered.dom.includes("elided by mcp-apps-harness"), "default DOM marks where script bodies were elided");
  assert(rendered.dom.includes("<ul id=\"repo-list\">"), "elision preserves the actual rendered markup");

  const withScripts = await renderPanel({ html, fixture, mode: "dom", includeScripts: true });
  assert(withScripts.dom.length > rawHtmlSize / 2, "includeScripts:true returns the full bundle verbatim");

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
