import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

const SESSION_DIR = path.join(
  process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
  "chat-mcp",
  "sessions",
);

export interface SessionFile {
  agent_id: string;
  username: string;
  project: string;
  claude_pid: number;
  written_at: number;
}

function pathFor(claude_pid: number): string {
  return path.join(SESSION_DIR, `${claude_pid}.json`);
}

export function writeSessionFile(data: Omit<SessionFile, "written_at">): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const payload: SessionFile = { ...data, written_at: Date.now() };
  fs.writeFileSync(pathFor(data.claude_pid), JSON.stringify(payload));
}

export function readSessionFile(claude_pid: number): SessionFile | null {
  try {
    const text = fs.readFileSync(pathFor(claude_pid), "utf8");
    const parsed = JSON.parse(text) as SessionFile;
    if (!isPidAlive(parsed.claude_pid)) {
      deleteSessionFile(parsed.claude_pid);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Walk up the process tree from our direct parent looking for a session file.
// This handles the case where we're run through a shell wrapper (Claude Code's
// Bash tool spawns `bash -c`, so our ppid is bash, not Claude Code).
export function readSessionFileByAncestor(
  startPid: number = process.ppid,
): { session: SessionFile; matched_pid: number } | null {
  let pid: number | null = startPid;
  const seen = new Set<number>();
  let hops = 0;
  while (pid && pid > 1 && !seen.has(pid) && hops < 20) {
    seen.add(pid);
    hops++;
    const session = readSessionFile(pid);
    if (session) return { session, matched_pid: pid };
    pid = readParentPid(pid);
  }
  return null;
}

function readParentPid(pid: number): number | null {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^PPid:\s+(\d+)/m);
    if (match) {
      const ppid = Number(match[1]);
      if (Number.isFinite(ppid) && ppid > 0) return ppid;
    }
  } catch {
    // fall through to ps
  }
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const ppid = Number(out.trim());
    if (Number.isFinite(ppid) && ppid > 0) return ppid;
  } catch {
    // ignore
  }
  return null;
}

export function deleteSessionFile(claude_pid: number): void {
  try {
    fs.unlinkSync(pathFor(claude_pid));
  } catch {
    // ignore
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
