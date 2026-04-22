import net from "node:net";
import path from "node:path";
import os from "node:os";

const SOCKET = path.join(
  process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
  "chat-mcp",
  "chat.sock",
);

class Client {
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
  close() { this.socket.end(); }
}

async function expectFail(p, label, includes) {
  try {
    await p;
    throw new Error(`FAIL: expected rejection for ${label}`);
  } catch (err) {
    if (!err.message.includes(includes)) {
      throw new Error(`FAIL ${label}: message missing "${includes}" — got: ${err.message}`);
    }
    console.log(`  ok: ${label} rejected — "${err.message.slice(0, 100)}..."`);
  }
}

async function expectOk(p, label) {
  await p;
  console.log(`  ok: ${label}`);
}

async function main() {
  const a = new Client(); await a.ready;
  await a.cmd({ type: "login", username: "finn42", project: "p1", status: "x" });
  console.log("logged in finn42");

  const b = new Client(); await b.ready;
  await expectFail(
    b.cmd({ type: "login", username: "finn99", project: "p2", status: "x" }),
    'finn99 should be rejected (shares "finn" with finn42)',
    "too similar",
  );
  await expectFail(
    b.cmd({ type: "login", username: "finnegan", project: "p2", status: "x" }),
    'finnegan should be rejected (shares "finn")',
    "too similar",
  );
  await expectFail(
    b.cmd({ type: "login", username: "FINN42", project: "p2", status: "x" }),
    "FINN42 case-insensitive collision",
    "already in use",
  );
  await expectOk(
    b.cmd({ type: "login", username: "zap", project: "p2", status: "x" }),
    "zap accepted (distinct prefix)",
  );
  await b.cmd({ type: "logout" }).catch(() => {});
  b.close();

  // Also verify the error includes the list of taken names
  const c = new Client(); await c.ready;
  try {
    await c.cmd({ type: "login", username: "finn00", project: "p3", status: "x" });
    throw new Error("should have failed");
  } catch (err) {
    if (!err.message.includes("Currently taken")) {
      throw new Error("FAIL: expected 'Currently taken' in error: " + err.message);
    }
    console.log("  ok: error includes Currently taken list");
  }
  c.close();

  await a.cmd({ type: "logout" });
  a.close();
  console.log("ALL GOOD");
}

main().catch((err) => { console.error(err); process.exit(1); });
