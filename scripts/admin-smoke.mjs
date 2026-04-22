import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const BIN = path.resolve("dist/bin.js");
const STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "chat-mcp-admin-smoke-"));
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
  constructor(name) {
    this.name = name;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
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

  // Agent logs in
  const alice = new Client("alice");
  await alice.ready;
  await alice.cmd({
    type: "login",
    username: "alice01",
    project: "admin-test",
    status: "present",
  });
  console.log("ok: alice logged in");

  // Reserve: login as admin should be rejected
  const impostor = new Client("impostor");
  await impostor.ready;
  let rejected = false;
  try {
    await impostor.cmd({
      type: "login",
      username: "admin",
      project: "admin-test",
      status: "impostor",
    });
  } catch (err) {
    if (err.message.includes("reserved")) rejected = true;
    else throw new Error("wrong rejection message: " + err.message);
  }
  if (!rejected) throw new Error("admin username should be reserved");
  console.log("ok: login as 'admin' rejected");
  // And case-insensitive
  let rejected2 = false;
  try {
    await impostor.cmd({
      type: "login",
      username: "ADMIN",
      project: "admin-test",
      status: "impostor",
    });
  } catch (err) {
    if (err.message.includes("reserved")) rejected2 = true;
  }
  if (!rejected2) throw new Error("ADMIN (caps) should be reserved too");
  console.log("ok: 'ADMIN' case-insensitive reject");
  impostor.close();

  // Console (monitor role) broadcasts — global
  const admin = new Client("admin-console");
  await admin.ready;
  const before = alice.events.length;
  await admin.cmd({
    type: "admin_broadcast",
    scope: "global",
    text: "deploy freeze in effect",
  });
  await sleep(100);
  const received = alice.events
    .slice(before)
    .find((m) => m.text === "deploy freeze in effect");
  if (!received) throw new Error("alice did not receive global admin broadcast");
  if (received.from !== "admin")
    throw new Error(`expected from='admin', got '${received.from}'`);
  if (received.scope !== "global")
    throw new Error(`expected scope=global, got '${received.scope}'`);
  console.log("ok: global admin broadcast reached agent");

  // DM
  const beforeDm = alice.events.length;
  await admin.cmd({
    type: "admin_broadcast",
    scope: "dm",
    target: "alice01",
    text: "hey alice, specific to you",
  });
  await sleep(100);
  const dm = alice.events
    .slice(beforeDm)
    .find((m) => m.text === "hey alice, specific to you");
  if (!dm) throw new Error("alice did not receive admin DM");
  if (dm.from !== "admin" || dm.scope !== "dm" || dm.target !== "alice01")
    throw new Error("admin DM fields wrong");
  console.log("ok: admin DM reached target");

  // DM to nonexistent user
  let dmErr = null;
  try {
    await admin.cmd({
      type: "admin_broadcast",
      scope: "dm",
      target: "nosuch99",
      text: "ghost",
    });
  } catch (e) {
    dmErr = e;
  }
  if (!dmErr || !dmErr.message.includes("nosuch99"))
    throw new Error("DM to nonexistent user should fail");
  console.log("ok: admin DM to nonexistent user rejected");

  // Project scope requires target
  let projErr = null;
  try {
    await admin.cmd({
      type: "admin_broadcast",
      scope: "project",
      text: "missing target",
    });
  } catch (e) {
    projErr = e;
  }
  if (!projErr || !projErr.message.includes("project"))
    throw new Error("project scope without target should fail");
  console.log("ok: project scope requires target");

  // Project broadcast lands on matching project only
  const bob = new Client("bob");
  await bob.ready;
  await bob.cmd({
    type: "login",
    username: "bob42",
    project: "other-proj",
    status: "present",
  });
  const aliceBeforeProj = alice.events.length;
  const bobBeforeProj = bob.events.length;
  await admin.cmd({
    type: "admin_broadcast",
    scope: "project",
    target: "admin-test",
    text: "only admin-test folks see this",
  });
  await sleep(100);
  const aliceSaw = alice.events
    .slice(aliceBeforeProj)
    .find((m) => m.text === "only admin-test folks see this");
  const bobSaw = bob.events
    .slice(bobBeforeProj)
    .find((m) => m.text === "only admin-test folks see this");
  if (!aliceSaw) throw new Error("alice (in project) should have received it");
  if (bobSaw) throw new Error("bob (other project) should NOT have received it");
  console.log("ok: project-scoped admin broadcast is scoped correctly");

  await alice.cmd({ type: "logout" });
  await bob.cmd({ type: "logout" });
  alice.close();
  bob.close();
  admin.close();
  daemon.kill("SIGTERM");
  await new Promise((r) => daemon.once("exit", r)).catch(() => {});
  console.log("ALL GOOD");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
