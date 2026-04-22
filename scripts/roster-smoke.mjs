// Verify monitor + console print the agent roster on startup.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const BIN = path.resolve("dist/bin.js");

// Isolated state dir so the smoke doesn't collide with a live daemon.
const STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "chat-mcp-roster-smoke-"));
const ENV = { ...process.env, XDG_STATE_HOME: STATE_HOME };
const SOCKET = path.join(STATE_HOME, "chat-mcp", "chat.sock");

process.on("exit", () => {
  try {
    fs.rmSync(STATE_HOME, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

class Peer {
  constructor() {
    this.seq = 0;
    this.pending = new Map();
    this.buf = "";
    this.socket = net.connect(SOCKET);
    this.ready = new Promise((r) => this.socket.once("connect", r));
    this.socket.on("data", (c) => {
      this.buf += c.toString();
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.kind === "result") {
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.data);
          else p.reject(new Error(msg.error));
        }
      }
    });
  }
  cmd(cmd) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, cmd }) + "\n");
    });
  }
  close() { this.socket.end(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runAndCapture(args, killAfterMs = 400) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [BIN, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: ENV,
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (c) => (stdout += c.toString()));
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("exit", () => resolve({ stdout, stderr }));
    proc.on("error", reject);
    setTimeout(() => proc.kill("SIGTERM"), killAfterMs);
  });
}

function spawnDaemon() {
  const proc = spawn(process.execPath, [BIN, "--daemon"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: ENV,
  });
  proc.stderr.on("data", () => {});
  return proc;
}

async function waitForSocket(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(SOCKET)) {
      try {
        await new Promise((resolve, reject) => {
          const s = net.connect(SOCKET);
          s.once("connect", () => {
            s.destroy();
            resolve();
          });
          s.once("error", reject);
        });
        return;
      } catch {
        // retry
      }
    }
    await sleep(50);
  }
  throw new Error("daemon socket didn't come up");
}

async function main() {
  const daemon = spawnDaemon();
  try {
    await waitForSocket();
  } catch (err) {
    daemon.kill();
    throw err;
  }

  // Two peers logged in
  const a = new Peer(); await a.ready;
  await a.cmd({ type: "login", username: "rhys88", project: "proj-a", status: "reviewing PR" });
  const b = new Peer(); await b.ready;
  await b.cmd({ type: "login", username: "mila42", project: "proj-b", status: "running tests" });

  await sleep(100);

  // monitor --no-color --no-tail
  const mon = await runAndCapture(["monitor", "--no-color", "--no-tail"]);
  if (!mon.stdout.includes("2 agent(s) connected")) {
    throw new Error("monitor did not print roster header\n" + mon.stdout);
  }
  if (!mon.stdout.includes("rhys88") || !mon.stdout.includes("mila42")) {
    throw new Error("monitor roster missing agents\n" + mon.stdout);
  }
  if (!mon.stdout.includes("proj-a") || !mon.stdout.includes("proj-b")) {
    throw new Error("monitor roster missing projects\n" + mon.stdout);
  }
  if (!mon.stdout.includes("reviewing PR") || !mon.stdout.includes("running tests")) {
    throw new Error("monitor roster missing statuses\n" + mon.stdout);
  }
  console.log("ok: monitor startup roster correct");

  // console --no-color --no-tail (drive /quit via stdin)
  const cproc = spawn(process.execPath, [BIN, "console", "--no-color", "--no-tail"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: ENV,
  });
  let cstdout = "", cstderr = "";
  cproc.stdout.on("data", (c) => (cstdout += c.toString()));
  cproc.stderr.on("data", (c) => (cstderr += c.toString()));
  await sleep(400);
  cproc.stdin.write("/quit\n");
  await new Promise((r) => cproc.on("exit", r));
  if (!cstdout.includes("2 agent(s) connected")) {
    throw new Error("console did not print roster header\n" + cstdout);
  }
  if (!cstdout.includes("rhys88") || !cstdout.includes("mila42")) {
    throw new Error("console roster missing agents\n" + cstdout);
  }
  console.log("ok: console startup roster correct");

  // Roster with no agents
  await a.cmd({ type: "logout" });
  await b.cmd({ type: "logout" });
  await sleep(100);
  const empty = await runAndCapture(["monitor", "--no-color", "--no-tail"]);
  if (!empty.stdout.includes("no agents connected")) {
    throw new Error("expected empty-roster message\n" + empty.stdout);
  }
  console.log("ok: empty roster handled");

  a.close(); b.close();
  daemon.kill("SIGTERM");
  await new Promise((r) => daemon.once("exit", r)).catch(() => {});
  console.log("ALL GOOD");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
