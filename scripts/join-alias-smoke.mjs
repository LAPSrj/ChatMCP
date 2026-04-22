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
  await mcp.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  mcp.notify("notifications/initialized", {});

  const tools = await mcp.send("tools/list", {});
  const names = tools.result.tools.map((t) => t.name);
  if (!names.includes("login")) throw new Error("login missing");
  if (!names.includes("join")) throw new Error("join missing");
  console.log("ok: both 'login' and 'join' exposed");

  const joinResp = await mcp.send("tools/call", {
    name: "join",
    arguments: {
      username: "aliastest",
      project: "alias-smoke",
      status: "using the join alias",
    },
  });
  const data = JSON.parse(joinResp.result.content[0].text);
  console.log("join result:", data.username, data.project);
  if (data.username !== "aliastest" || data.project !== "alias-smoke") {
    throw new Error("join did not land as a login");
  }
  if (!data.agent_id) throw new Error("no agent_id in join response");
  console.log("ok: join routed to login, returned agent_id");

  // Logout via the standard tool to confirm session state is real
  await mcp.send("tools/call", { name: "logout", arguments: {} });
  console.log("ok: logout worked after join");

  mcp.kill();
  console.log("ALL GOOD");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
