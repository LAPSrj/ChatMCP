import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const BIN = path.resolve("dist/bin.js");

// Isolated state dir so the smoke doesn't collide with a live daemon serving
// real agents on this machine (name uniqueness, roster pollution, etc.).
const STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "chat-mcp-loop-smoke-"));
const ENV = { ...process.env, XDG_STATE_HOME: STATE_HOME };
const STATE_DIR = path.join(STATE_HOME, "chat-mcp");
const SOCKET = path.join(STATE_DIR, "chat.sock");

process.on("exit", () => {
  try {
    fs.rmSync(STATE_HOME, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

class McpDriver {
  constructor() {
    this.proc = spawn(process.execPath, [BIN], {
      stdio: ["pipe", "pipe", "inherit"],
      env: ENV,
    });
    this.buf = "";
    this.seq = 0;
    this.pending = new Map();
    this.proc.stdout.on("data", (c) => {
      this.buf += c.toString();
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id != null) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            p.resolve(msg);
          }
        }
      }
    });
  }
  send(method, params) {
    const id = ++this.seq;
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    return new Promise((resolve) => this.pending.set(id, { resolve }));
  }
  notify(method, params) {
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }
  kill() {
    this.proc.stdin.end();
    setTimeout(() => this.proc.kill(), 200);
  }
}

class Peer {
  constructor() {
    this.seq = 0;
    this.pending = new Map();
    this.buf = "";
    this.socket = net.connect(SOCKET);
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
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
  close() {
    this.socket.end();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const mcp = new McpDriver();
  await mcp.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  mcp.notify("notifications/initialized", {});
  const loginResp = await mcp.send("tools/call", {
    name: "login",
    arguments: { username: "looper", project: "loop-test", status: "running" },
  });
  const loginData = JSON.parse(loginResp.result.content[0].text);
  console.log("logged in as", loginData.username);

  // Spawn fetch --loop through bash -c (realistic)
  const loop = spawn(
    "bash",
    ["-c", `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} fetch --loop --wait 5`],
    { stdio: ["ignore", "pipe", "pipe"], env: ENV },
  );
  const lines = [];
  loop.stdout.on("data", (c) => {
    const str = c.toString();
    for (const line of str.split("\n")) {
      if (line.trim()) {
        console.log("loop stdout:", line);
        lines.push(line);
      }
    }
  });
  loop.stderr.on("data", (c) => process.stderr.write("loop stderr: " + c));

  // Wait for startup line
  await sleep(400);
  if (!lines.some((l) => l.includes("streaming messages for looper"))) {
    throw new Error("loop didn't emit startup line");
  }
  console.log("ok: loop started");

  // Send messages from a peer
  const peer = new Peer();
  await peer.ready;
  await peer.cmd({
    type: "login",
    username: "poker77",
    project: "loop-test",
    status: "poking",
  });
  await peer.cmd({
    type: "send_message",
    text: "first message",
    scope: "dm",
    target: "looper",
  });
  await sleep(300);
  await peer.cmd({
    type: "send_message",
    text: "second message",
    scope: "dm",
    target: "looper",
  });
  await sleep(300);
  await peer.cmd({
    type: "send_message",
    text: "third message",
    scope: "global",
  });
  await sleep(500);

  const firstIdx = lines.findIndex((l) => l.includes("first message"));
  const secondIdx = lines.findIndex((l) => l.includes("second message"));
  const thirdIdx = lines.findIndex((l) => l.includes("third message"));
  if (firstIdx < 1) throw new Error("missed first message");
  if (secondIdx < 1) throw new Error("missed second message");
  if (thirdIdx < 1) throw new Error("missed third message");
  // Confirm headers are flush-left (loop mode must not use the 2-space
  // hanging indent one-shot mode adds). Bodies are deliberately indented 4
  // spaces by wrapBody; Monitor batches header+body lines emitted within
  // 200ms into a single notification, so a message still arrives as one unit.
  for (const [name, idx] of [
    ["first", firstIdx],
    ["second", secondIdx],
    ["third", thirdIdx],
  ]) {
    const header = lines[idx - 1];
    if (!header || /^\s/.test(header)) {
      throw new Error(
        `${name} message header should be flush-left in loop mode, got: ${JSON.stringify(header)}`,
      );
    }
  }
  console.log("ok: 3 messages surfaced with flush-left headers");

  // Verify the loop is still running after output (no exit on messages)
  if (loop.exitCode !== null) {
    throw new Error("loop exited prematurely");
  }
  console.log("ok: loop still running");

  // Terminate
  loop.kill("SIGTERM");
  await new Promise((r) => loop.once("exit", r));
  console.log("ok: loop terminates on SIGTERM");

  await peer.cmd({ type: "logout" }).catch(() => {});
  peer.close();
  await mcp.send("tools/call", { name: "logout", arguments: {} });
  mcp.kill();
  console.log("ALL GOOD");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
