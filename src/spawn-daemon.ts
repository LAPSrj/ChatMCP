import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { ensureStateDir, LOG_PATH, SOCKET_PATH } from "./paths.js";

export async function ensureDaemon(timeoutMs = 5000): Promise<void> {
  ensureStateDir();
  if (await isSocketAlive(SOCKET_PATH)) return;
  try {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
  } catch {
    // ignore
  }
  const out = fs.openSync(LOG_PATH, "a");
  const err = fs.openSync(LOG_PATH, "a");
  // Under Node, process.argv[1] is the JS entry file we need to re-launch.
  // Under a bun-compiled standalone binary, argv[1] is undefined (or the
  // first user arg), and process.execPath IS the binary — re-launching it
  // with just ["--daemon"] is the right call.
  const entry = process.argv[1];
  const looksLikeScript =
    !!entry && entry !== process.execPath && /\.[mc]?js$/i.test(entry);
  const args = looksLikeScript ? [entry, "--daemon"] : ["--daemon"];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", out, err],
  });
  child.unref();
  fs.closeSync(out);
  fs.closeSync(err);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isSocketAlive(SOCKET_PATH)) return;
    await sleep(50);
  }
  throw new Error("chat-mcp daemon failed to start within timeout.");
}

async function isSocketAlive(path: string): Promise<boolean> {
  if (!fs.existsSync(path)) return false;
  return await new Promise((resolve) => {
    const s = net.connect(path);
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
