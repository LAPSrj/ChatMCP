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
    arguments: { username: "idflag", project: "aid-test", status: "test" },
  });
  const loginData = JSON.parse(loginResp.result.content[0].text);
  console.log("agent_id:", loginData.agent_id);

  // 1. Verify note contains the agent_id + --agent-id
  if (!loginData.note.includes(`--agent-id ${loginData.agent_id}`)) {
    throw new Error(`login note missing "--agent-id ${loginData.agent_id}" — got:\n${loginData.note}`);
  }
  console.log("ok: login note contains --agent-id <id>");

  // 2. DELETE the session file — simulates stale ancestry / sandbox mismatch
  const sessionPath = path.join(STATE_DIR, "sessions", `${process.pid}.json`);
  if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
  console.log("ok: session file deleted");

  // 3. Peer sends a message
  const peer = new Peer();
  await peer.ready;
  await peer.cmd({
    type: "login",
    username: "sender77",
    project: "aid-test",
    status: "sending",
  });
  await peer.cmd({
    type: "send_message",
    text: "hello via agent-id",
    scope: "dm",
    target: "idflag",
  });

  // 4. Run fetch with --agent-id — should work even with no session file
  const res = spawnSync(
    "bash",
    [
      "-c",
      `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} fetch --agent-id ${loginData.agent_id} --wait 3`,
    ],
    { encoding: "utf8" },
  );
  console.log("--- fetch --agent-id output ---");
  console.log(res.stdout);
  console.log("--- (end) ---");
  if (res.status !== 0) {
    throw new Error(`fetch --agent-id failed: status=${res.status}, stderr=${res.stderr}`);
  }
  if (!res.stdout.includes("hello via agent-id")) {
    throw new Error("fetch --agent-id did not return the DM");
  }
  console.log("ok: fetch --agent-id works without a session file");

  // 5. Negative case — bad agent_id
  const bad = spawnSync(
    "bash",
    [
      "-c",
      `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} fetch --agent-id bad-id --wait 1`,
    ],
    { encoding: "utf8" },
  );
  if (bad.status === 0) throw new Error("expected non-zero for bad agent-id");
  if (!bad.stderr.includes("Session expired")) {
    throw new Error(`expected 'Session expired' in stderr, got: ${bad.stderr}`);
  }
  console.log("ok: bad --agent-id returns Session expired");

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
