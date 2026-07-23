/**
 * Project config convenience: a `.mcp-apps-harness.json` in the project root
 * mapping a short panel name to its built HTML (and, optionally, the command
 * that produces it), so callers can say `renderPanel({ panel: "repos" })`
 * instead of tracking build output paths by hand.
 *
 * A panel may be declared by `path` (read off disk) or by `url` (fetched from a
 * running dev server). The `url` form needs no filesystem access, which matters
 * when the harness runs somewhere that can't read the project directory — see
 * `panelUrl` in harness.ts.
 *
 * Example `.mcp-apps-harness.json`:
 * ```json
 * {
 *   "panels": {
 *     "repos": { "path": "src/ui/dist/repos.html", "buildCommand": "npm run build:ui" },
 *     "repos-dev": { "url": "http://localhost:5173/repos.html" }
 *   }
 * }
 * ```
 */
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface PanelConfigEntry {
  /** Path to the built single-file HTML, relative to the config file's directory. Provide `path` or `url`. */
  path?: string;
  /** URL to fetch the built single-file HTML from, e.g. a dev server. Provide `path` or `url`. */
  url?: string;
  /** Shell command run (with the config file's directory as cwd) before resolving `path`/`url`. */
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

async function resolveEntry(
  name: string,
  cwd: string,
): Promise<{ entry: PanelConfigEntry; configDir: string }> {
  const loaded = await loadConfig(cwd);
  if (!loaded) {
    throw new Error(
      `mcp-apps-harness: no ${CONFIG_FILENAME} found in ${cwd} (needed to resolve panel "${name}" — pass \`panelPath\`/\`panelUrl\`/\`html\` directly instead, or add a ${CONFIG_FILENAME})`,
    );
  }
  const entry = loaded.config.panels?.[name];
  if (!entry) {
    const known = Object.keys(loaded.config.panels ?? {});
    throw new Error(
      `mcp-apps-harness: panel "${name}" not found in ${CONFIG_FILENAME} (known panels: ${known.join(", ") || "none"})`,
    );
  }
  if (!entry.path && !entry.url) {
    throw new Error(`mcp-apps-harness: panel "${name}" in ${CONFIG_FILENAME} declares neither \`path\` nor \`url\``);
  }
  if (entry.buildCommand) {
    await runBuildCommand(entry.buildCommand, loaded.configDir);
  }
  return { entry, configDir: loaded.configDir };
}

/** A config-declared panel resolved to a single concrete source. */
export type ResolvedPanel = { kind: "url"; url: string } | { kind: "path"; path: string };

/**
 * Resolve a panel name to either a URL or an on-disk path, running its
 * `buildCommand` first if one is configured. Runs that command as a shell
 * command in the config file's directory — executing exactly what the
 * project's own `.mcp-apps-harness.json` declares, the same trust boundary as
 * any other npm script in the repo.
 *
 * Single entry point on purpose: callers must not probe for a URL and then
 * fall back to a path, since each call runs `buildCommand` again.
 */
export async function resolvePanel(name: string, cwd: string = process.cwd()): Promise<ResolvedPanel> {
  const { entry, configDir } = await resolveEntry(name, cwd);
  if (entry.url) return { kind: "url", url: entry.url };
  return { kind: "path", path: path.resolve(configDir, entry.path as string) };
}

/**
 * Resolve a panel name to a built HTML path. Throws for `url`-declared panels —
 * use {@link resolvePanel} when either form is acceptable.
 */
export async function resolvePanelPath(name: string, cwd: string = process.cwd()): Promise<string> {
  const resolved = await resolvePanel(name, cwd);
  if (resolved.kind !== "path") {
    throw new Error(`mcp-apps-harness: panel "${name}" is declared by \`url\`, not \`path\``);
  }
  return resolved.path;
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
