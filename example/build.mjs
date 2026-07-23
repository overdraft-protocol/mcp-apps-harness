import { build } from "esbuild";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const result = await build({
    entryPoints: [path.join(__dirname, "src/panel.ts")],
    bundle: true,
    format: "iife",
    target: "es2020",
    write: false,
    logLevel: "info",
  });
  const js = result.outputFiles[0].text.replace(/<\/script>/g, "<\\/script>");
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>example-repos-panel</title></head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`;
  const outDir = path.join(__dirname, "dist");
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "panel.html");
  await writeFile(outFile, html, "utf-8");
  console.log("wrote", outFile);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
