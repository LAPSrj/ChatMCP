import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function summonAgentsDir(): string {
  const base =
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "summon-mcp", "agents");
}

/**
 * Best-effort read of summon-mcp's on-disk registry. Returns the set of
 * registered usernames, or empty set if summon isn't installed, the dir is
 * unreadable, or any file fails to parse. Never throws.
 *
 * Mirrors summon's own read pattern — format contract coordinated with
 * quibblethorn (summon-mcp): `agents/<username>.json`, skip `.memory.`
 * filenames, canonical name is the `username` field.
 */
export function readSummonUsernames(dir: string = summonAgentsDir()): Set<string> {
  const out = new Set<string>();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith(".json") || name.includes(".memory.")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, name), "utf8");
      const parsed = JSON.parse(raw) as { username?: unknown };
      if (typeof parsed.username === "string" && parsed.username.length > 0) {
        out.add(parsed.username);
      }
    } catch {
      // skip unreadable entry
    }
  }
  return out;
}
