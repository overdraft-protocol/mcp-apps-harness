import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const cliPath = path.join(rootDir, "dist/cli.js");
const panelPath = path.join(__dirname, "dist/panel.html");
const fixturePath = path.join(__dirname, "fixture.json");

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
  // 1. render --out writes a real PNG.
  const outPng = path.join(__dirname, "dist/cli-selftest.png");
  await rm(outPng, { force: true });
  const renderOut = await execFileAsync("node", [
    cliPath,
    "render",
    "--panel-path",
    panelPath,
    "--fixture",
    `@${fixturePath}`,
    "--out",
    outPng,
  ]);
  assert(renderOut.stdout.includes("Console errors: none"), "cli render: no console errors reported");
  assert(renderOut.stdout.includes(`Screenshot written to ${outPng}`), "cli render: reports screenshot path");
  const pngStat = await stat(outPng);
  assert(pngStat.size > 0, "cli render: PNG file was actually written");

  // 2. render --json --mode dom, plus inline --steps with respondWith.
  const jsonOut = await execFileAsync("node", [
    cliPath,
    "render",
    "--panel-path",
    panelPath,
    "--fixture",
    `@${fixturePath}`,
    "--mode",
    "dom",
    "--steps",
    JSON.stringify([
      {
        action: { type: "click", selector: "#save-btn" },
        respondWith: { tool: "repos_set", result: { content: [], isError: false } },
      },
    ]),
    "--json",
  ]);
  const parsed = JSON.parse(jsonOut.stdout);
  assert(parsed.dom.includes('id="status">saved<'), "cli render --json: interact step applied via CLI");

  // 3. --panel/--cwd resolves through .mcp-apps-harness.json.
  const panelOut = await execFileAsync("node", [
    cliPath,
    "render",
    "--panel",
    "repos",
    "--cwd",
    __dirname,
    "--fixture",
    `@${fixturePath}`,
    "--mode",
    "dom",
  ]);
  assert(panelOut.stdout.includes("Console errors: none"), "cli render --panel: resolves via .mcp-apps-harness.json");

  // 4. capture-fixture against our own mcp-server.js.
  const capturedPath = path.join(__dirname, "dist/cli-selftest-captured.json");
  await rm(capturedPath, { force: true });
  const fixtureContent = await readFile(fixturePath, "utf-8");
  await execFileAsync("node", [
    cliPath,
    "capture-fixture",
    "--command",
    "node",
    "--arg",
    path.join(rootDir, "dist/mcp-server.js"),
    "--tool",
    "render_panel",
    "--tool-args",
    JSON.stringify({ panelPath, fixture: JSON.parse(fixtureContent), mode: "dom" }),
    "--out",
    capturedPath,
  ]);
  const captured = JSON.parse(await readFile(capturedPath, "utf-8"));
  assert(typeof captured.dom === "string" && captured.dom.includes("overdraft"), "cli capture-fixture: wrote structuredContent with expected dom");

  // 5. Usage/error paths exit non-zero without crashing weirdly.
  await assertRejectsWithNonZeroExit(() => execFileAsync("node", [cliPath, "render"]), "cli render with no args exits non-zero");
  await assertRejectsWithNonZeroExit(() => execFileAsync("node", [cliPath, "bogus-command"]), "cli with unknown command exits non-zero");

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll CLI checks passed.");
}

async function assertRejectsWithNonZeroExit(fn, message) {
  try {
    await fn();
    assert(false, message);
  } catch (err) {
    assert(typeof err.code === "number" && err.code !== 0, message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
