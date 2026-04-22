// Drive `chat-mcp console` via piped stdin and verify it broadcasts.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const BIN = path.resolve("dist/bin.js");
const STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "chat-mcp-console-smoke-"));
const ENV = { ...process.env, XDG_STATE_HOME: STATE_HOME };
const SOCKET = path.join(STATE_HOME, "chat-mcp", "chat.sock");

process.on("exit", () => {
  try {
    fs.rmSync(STATE_HOME, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

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
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("daemon socket didn't come up");
}

class Client {
  constructor() {
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
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
        } else if (msg.kind === "event") {
          this.events.push(msg.data);
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
  close() {
    this.socket.end();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const daemon = spawn(process.execPath, [BIN, "--daemon"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: ENV,
  });
  daemon.stderr.on("data", () => {});
  try {
    await waitForSocket();
  } catch (err) {
    daemon.kill();
    throw err;
  }

  const alice = new Client();
  await alice.ready;
  await alice.cmd({
    type: "login",
    username: "aliceX",
    project: "repl-test",
    status: "present",
  });

  // Spawn the console with piped stdin/stdout so we can drive it
  const cproc = spawn(
    process.execPath,
    [BIN, "console", "--no-color", "--no-tail"],
    { stdio: ["pipe", "pipe", "pipe"], env: ENV },
  );
  let stdout = "";
  cproc.stdout.on("data", (c) => (stdout += c.toString()));
  cproc.stderr.on("data", (c) => (stdout += c.toString()));
  await sleep(400); // let it come up

  // Send a global broadcast (no slash = default global)
  cproc.stdin.write("attention team\n");
  await sleep(250);

  // DM to alice
  cproc.stdin.write("/dm aliceX ping\n");
  await sleep(250);

  // Project broadcast
  cproc.stdin.write("/proj repl-test heads up\n");
  await sleep(250);

  // /who
  cproc.stdin.write("/who\n");
  await sleep(250);

  // Exit cleanly
  cproc.stdin.write("/quit\n");
  await sleep(300);

  const globalMsg = alice.events.find((m) => m.text === "attention team");
  const dmMsg = alice.events.find((m) => m.text === "ping");
  const projMsg = alice.events.find((m) => m.text === "heads up");
  if (!globalMsg) throw new Error("alice missed default-global broadcast");
  if (globalMsg.from !== "admin") throw new Error("broadcast not from admin");
  if (!dmMsg) throw new Error("alice missed /dm");
  if (dmMsg.scope !== "dm") throw new Error("/dm wrong scope");
  if (!projMsg) throw new Error("alice missed /proj");
  if (projMsg.scope !== "project" || projMsg.target !== "repl-test") {
    throw new Error("/proj wrong scope/target");
  }
  if (!stdout.includes("aliceX")) {
    throw new Error("/who didn't list alice (stdout=\n" + stdout + ")");
  }

  console.log("ok: default-global, /dm, /proj, /who all verified");

  // The console MUST NOT echo its own broadcasts back on stdout.
  // The admin already saw what they typed at the prompt; surfacing the
  // same message again via the monitor stream is noise.
  const echoLines = stdout
    .split("\n")
    .filter((l) =>
      l.includes("attention team") ||
      l.includes("ping") ||
      l.includes("heads up"),
    );
  if (echoLines.length > 0) {
    throw new Error(
      "console echoed its own broadcasts back to stdout (expected none):\n" +
        echoLines.join("\n"),
    );
  }
  console.log("ok: own broadcasts NOT echoed to console stdout");

  await alice.cmd({ type: "logout" });
  alice.close();
  daemon.kill("SIGTERM");
  await new Promise((r) => daemon.once("exit", r)).catch(() => {});
  console.log("ALL GOOD");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
