import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const BIN = path.resolve("dist/bin.js");
const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
  "chat-mcp",
);
const SOCKET = path.join(STATE_DIR, "chat.sock");

class McpDriver {
  constructor() {
    this.proc = spawn(process.execPath, [BIN], {
      stdio: ["pipe", "pipe", "inherit"],
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
    const req = { jsonrpc: "2.0", id, method, params };
    this.proc.stdin.write(JSON.stringify(req) + "\n");
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

// Peer: raw socket, pretends to be another agent
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

async function main() {
  // Step 1: boot MCP server (Claude-side stdio), auto-spawns daemon
  const mcp = new McpDriver();
  await mcp.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  mcp.notify("notifications/initialized", {});

  const login = await mcp.send("tools/call", {
    name: "login",
    arguments: { username: "watcher42", project: "bg-test", status: "running" },
  });
  const loginData = JSON.parse(login.result.content[0].text);
  console.log("logged in:", loginData.username);

  // Step 2: verify session file was written at <mcp.proc.pid's parent = our pid>
  const sessionPath = path.join(STATE_DIR, "sessions", `${process.pid}.json`);
  if (!fs.existsSync(sessionPath)) {
    throw new Error(`session file not created at ${sessionPath}`);
  }
  const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  console.log("session file:", session);
  if (session.username !== "watcher42") {
    throw new Error("wrong username in session file");
  }

  // Step 3: peer sends a DM while we're not looking
  const peer = new Peer();
  await peer.ready;
  await peer.cmd({
    type: "login",
    username: "sender99",
    project: "bg-test",
    status: "sending",
  });
  await peer.cmd({
    type: "send_message",
    text: "hey @watcher42 are you around?",
    scope: "dm",
    target: "watcher42",
  });

  // Step 4: run `chat-mcp fetch --wait 5` THROUGH A BASH WRAPPER — this is what
  // Claude Code's Bash tool does. Confirms the ancestor-walk finds our session.
  const fetchRes = spawnSync(
    "bash",
    ["-c", `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} fetch --wait 5`],
    { encoding: "utf8" },
  );
  console.log("--- fetch output ---");
  console.log(fetchRes.stdout);
  console.log("--- (end) ---");
  if (fetchRes.status !== 0) {
    throw new Error(`fetch exited with ${fetchRes.status}: ${fetchRes.stderr}`);
  }
  if (!fetchRes.stdout.includes("hey @watcher42 are you around?")) {
    throw new Error("fetch did not include the DM");
  }

  // Step 5: run fetch again — should return "no new messages" after 2s
  const t0 = Date.now();
  const fetchRes2 = spawnSync(process.execPath, [BIN, "fetch", "--wait", "2"], {
    encoding: "utf8",
  });
  const elapsed = Date.now() - t0;
  if (!fetchRes2.stdout.includes("No new")) {
    throw new Error("expected 'No new' on second fetch, got: " + fetchRes2.stdout);
  }
  if (elapsed < 1500) {
    throw new Error(`expected long-poll wait, only took ${elapsed}ms`);
  }
  console.log(`second fetch correctly waited ~${elapsed}ms and returned empty`);

  // Step 6: --rewake exit codes
  await peer.cmd({
    type: "send_message",
    text: "another one",
    scope: "dm",
    target: "watcher42",
  });
  const fetchRewake = spawnSync(
    process.execPath,
    [BIN, "fetch", "--wait", "3", "--rewake"],
    { encoding: "utf8" },
  );
  if (fetchRewake.status !== 2) {
    throw new Error(`expected --rewake exit 2 when messages found, got ${fetchRewake.status}`);
  }
  const fetchRewakeEmpty = spawnSync(
    process.execPath,
    [BIN, "fetch", "--wait", "2", "--rewake"],
    { encoding: "utf8" },
  );
  if (fetchRewakeEmpty.status !== 0) {
    throw new Error(`expected --rewake exit 0 when empty, got ${fetchRewakeEmpty.status}`);
  }
  console.log("--rewake exit codes verified");

  // Step 7: logout removes session file
  await mcp.send("tools/call", { name: "logout", arguments: {} });
  if (fs.existsSync(sessionPath)) {
    throw new Error("session file should be deleted after logout");
  }
  console.log("session file cleaned up after logout");

  await peer.cmd({ type: "logout" }).catch(() => {});
  peer.close();
  mcp.kill();
  console.log("ALL GOOD");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
