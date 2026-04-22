import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
  "chat-mcp",
);

export const SOCKET_PATH = path.join(STATE_DIR, "chat.sock");
export const PID_PATH = path.join(STATE_DIR, "daemon.pid");
export const LOG_PATH = path.join(STATE_DIR, "daemon.log");

export function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}
