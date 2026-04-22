import { spawn } from "node:child_process";
import path from "node:path";

const BIN = path.resolve("dist/bin.js");

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

async function login(clientCaps, username) {
  const mcp = new McpDriver();
  await mcp.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: clientCaps,
    clientInfo: { name: "smoke", version: "0" },
  });
  mcp.notify("notifications/initialized", {});
  const resp = await mcp.send("tools/call", {
    name: "login",
    arguments: { username, project: "detect-smoke", status: "running" },
  });
  const data = JSON.parse(resp.result.content[0].text);
  await mcp.send("tools/call", { name: "logout", arguments: {} });
  mcp.kill();
  return data;
}

async function main() {
  console.log("### client WITHOUT channels capability ###");
  const a = await login({}, "noch99");
  console.log("channels_enabled:", a.channels_enabled);
  console.log("note:", a.note);
  if (a.channels_enabled !== false) throw new Error("expected false");
  if (!a.note.includes("NOT enabled") || !a.note.includes("fetch --wait"))
    throw new Error("note should tell agent to spawn watcher");

  console.log("\n### client WITH channels capability ###");
  const b = await login(
    { experimental: { "claude/channel": {} } },
    "yesch42",
  );
  console.log("channels_enabled:", b.channels_enabled);
  console.log("note:", b.note);
  if (b.channels_enabled !== true) throw new Error("expected true");
  if (!b.note.includes("ARE enabled") || b.note.includes("fetch --wait"))
    throw new Error("note should say channels on and NOT recommend watcher");

  console.log("\nALL GOOD");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
