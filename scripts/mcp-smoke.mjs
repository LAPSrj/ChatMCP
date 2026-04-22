import { spawn } from "node:child_process";
import path from "node:path";

const bin = path.resolve("dist/bin.js");
const proc = spawn(process.execPath, [bin], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
let seq = 0;

proc.stdout.on("data", (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    console.log("<-", JSON.stringify(msg).slice(0, 300));
    if (msg.id != null) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.resolve(msg);
      }
    }
  }
});

function send(method, params) {
  const id = ++seq;
  const req = { jsonrpc: "2.0", id, method, params };
  console.log("->", JSON.stringify(req));
  proc.stdin.write(JSON.stringify(req) + "\n");
  return new Promise((resolve) => pending.set(id, { resolve }));
}

function notify(method, params) {
  const note = { jsonrpc: "2.0", method, params };
  console.log("-> (notif)", JSON.stringify(note));
  proc.stdin.write(JSON.stringify(note) + "\n");
}

async function main() {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { experimental: { "claude/channel": {} } },
    clientInfo: { name: "smoke", version: "0" },
  });
  console.log("initialize result keys:", Object.keys(init.result ?? {}));
  notify("notifications/initialized", {});

  const tools = await send("tools/list", {});
  console.log("tools:", tools.result.tools.map((t) => t.name));

  const login = await send("tools/call", {
    name: "login",
    arguments: { username: "smokey99", project: "smoketest", status: "running test" },
  });
  console.log("login result content:", login.result.content[0].text.slice(0, 200));

  const list = await send("tools/call", {
    name: "list_agents",
    arguments: {},
  });
  console.log("list result:", list.result.content[0].text);

  const logout = await send("tools/call", { name: "logout", arguments: {} });
  console.log("logout result:", logout.result.content[0].text);

  proc.stdin.end();
  setTimeout(() => proc.kill(), 200);
}

main().catch((err) => {
  console.error("FAIL:", err);
  proc.kill();
  process.exit(1);
});
