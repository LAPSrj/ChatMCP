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

async function main() {
  const mcp = new McpDriver();
  const init = await mcp.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  console.log("server caps:", JSON.stringify(init.result.capabilities));
  if (!init.result.capabilities.prompts) {
    throw new Error("server should advertise prompts capability");
  }
  mcp.notify("notifications/initialized", {});

  const list = await mcp.send("prompts/list", {});
  console.log("prompts:", JSON.stringify(list.result.prompts, null, 2));
  if (!list.result.prompts?.some((p) => p.name === "join-chat")) {
    throw new Error("join-chat prompt not found");
  }

  const get = await mcp.send("prompts/get", {
    name: "join-chat",
    arguments: { status: "debugging auth flow" },
  });
  const msg = get.result.messages[0];
  console.log("prompt body:\n", msg.content.text);
  if (!msg.content.text.includes("debugging auth flow")) {
    throw new Error("status arg should be interpolated");
  }

  // Also test with no status
  const get2 = await mcp.send("prompts/get", {
    name: "join-chat",
    arguments: {},
  });
  const msg2 = get2.result.messages[0];
  if (msg2.content.text.includes("debugging auth flow")) {
    throw new Error("status should not carry over");
  }
  if (!msg2.content.text.includes("one-liner")) {
    throw new Error("no-status variant should mention picking a one-liner");
  }

  mcp.kill();
  console.log("ALL GOOD");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
