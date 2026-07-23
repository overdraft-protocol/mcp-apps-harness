/**
 * Project config convenience: a `.mcp-apps-harness.json` in the project root
 * mapping a short panel name to its built HTML path (and, optionally, the
 * command that produces it), so callers can say `renderPanel({ panel: "repos" })`
 * instead of tracking build output paths by hand.
 *
 * Example `.mcp-apps-harness.json`:
 * ```json
 * { "panels": { "repos": { "path": "src/ui/dist/repos.html", "buildCommand": "npm run build:ui" } } }
 * ```
 */
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface PanelConfigEntry {
  /** Path to the built single-file HTML, relative to the config file's directory. */
  path: string;
  /** Shell command run (via the config file's directory as cwd) before resolving `path`. */
  buildCommand?: string;
}

export interface HarnessConfig {
  panels: Record<string, PanelConfigEntry>;
}

export const CONFIG_FILENAME = ".mcp-apps-harness.json";

export async function loadConfig(
  cwd: string = process.cwd(),
): Promise<{ config: HarnessConfig; configDir: string } | undefined> {
  const configPath = path.join(cwd, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let config: HarnessConfig;
  try {
    config = JSON.parse(raw) as HarnessConfig;
  } catch (err) {
    throw new Error(`mcp-apps-harness: failed to parse ${configPath}: ${(err as Error).message}`);
  }
  return { config, configDir: cwd };
}

/**
 * Resolve a panel name to a built HTML path, running its `buildCommand` first
 * if one is configured. Runs the command as a shell command in the config
 * file's directory — this executes exactly what the project's own
 * `.mcp-apps-harness.json` declares, the same trust boundary as any other
 * npm script in the repo.
 */
export async function resolvePanelPath(name: string, cwd: string = process.cwd()): Promise<string> {
  const loaded = await loadConfig(cwd);
  if (!loaded) {
    throw new Error(
      `mcp-apps-harness: no ${CONFIG_FILENAME} found in ${cwd} (needed to resolve panel "${name}" — pass \`panelPath\`/\`html\` directly instead, or add a ${CONFIG_FILENAME})`,
    );
  }
  const entry = loaded.config.panels?.[name];
  if (!entry) {
    const known = Object.keys(loaded.config.panels ?? {});
    throw new Error(
      `mcp-apps-harness: panel "${name}" not found in ${CONFIG_FILENAME} (known panels: ${known.join(", ") || "none"})`,
    );
  }
  if (entry.buildCommand) {
    await runBuildCommand(entry.buildCommand, loaded.configDir);
  }
  return path.resolve(loaded.configDir, entry.path);
}

function runBuildCommand(command: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`mcp-apps-harness: buildCommand "${command}" failed: ${stderr || err.message}`));
      } else {
        resolve();
      }
    });
  });
}
