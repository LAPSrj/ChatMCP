import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const BIN = path.resolve("dist/bin.js");
const STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "chat-mcp-smoke-"));
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
    this.socket.on("data", (chunk) => this.handleData(chunk));
  }
  handleData(chunk) {
    this.buf += chunk.toString();
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
        this.events.push(msg);
        console.log(`[${this.name} event]`, msg.data.from, msg.data.scope, "->", msg.data.text);
      }
    }
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function assert(cond, label) {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`  ok: ${label}`);
}

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

  console.log("### login both ###");
  const alice = new Client("alice");
  await alice.ready;
  const aliceLogin = await alice.cmd({
    type: "login",
    username: "alice01",
    project: "proj-a",
    status: "testing",
  });
  console.log("alice login:", aliceLogin);
  await assert(aliceLogin.username === "alice01", "alice username");

  const bob = new Client("bob");
  await bob.ready;
  const bobLogin = await bob.cmd({
    type: "login",
    username: "bob42",
    project: "proj-b",
    status: "lurking",
  });
  console.log("bob login:", bobLogin);

  console.log("### list_agents ###");
  const list = await alice.cmd({ type: "list_agents" });
  console.log(list);
  await assert(list.agents.length === 2, "two agents connected");

  console.log("### global send ###");
  const sent = await alice.cmd({
    type: "send_message",
    text: "hi @bob42, testing global",
    scope: "global",
  });
  console.log("sent:", sent);
  await assert(sent.mentions.includes("bob42"), "mention parsed");
  await sleep(50);
  const bobCheck1 = await bob.cmd({ type: "check_messages" });
  console.log("bob sees:", bobCheck1.messages.map((m) => `${m.from}: ${m.text}`));
  await assert(
    bobCheck1.messages.some((m) => m.from === "alice01" && m.text.includes("testing global")),
    "bob got alice's global",
  );

  console.log("### project scope isolation ###");
  await alice.cmd({
    type: "send_message",
    text: "proj-a only",
    scope: "project",
  });
  await sleep(50);
  const bobCheckProj = await bob.cmd({ type: "check_messages" });
  await assert(
    !bobCheckProj.messages.some((m) => m.text === "proj-a only"),
    "bob (proj-b) does NOT see proj-a message",
  );

  console.log("### default scope is project (no scope field) ###");
  const carol = new Client("carol");
  await carol.ready;
  await carol.cmd({
    type: "login",
    username: "carol3",
    project: "proj-a",
    status: "default-scope check",
  });
  const defSend = await alice.cmd({
    type: "send_message",
    text: "default scope should land in proj-a",
  });
  await assert(
    defSend.delivered_to === 1,
    "default scope reaches only proj-a peer (carol), not bob in proj-b",
  );
  await sleep(50);
  const carolCheck = await carol.cmd({ type: "check_messages" });
  await assert(
    carolCheck.messages.some((m) => m.text === "default scope should land in proj-a" && m.scope === "project"),
    "carol (proj-a) sees the default-scope message marked as project",
  );
  const bobCheckDefault = await bob.cmd({ type: "check_messages" });
  await assert(
    !bobCheckDefault.messages.some((m) => m.text === "default scope should land in proj-a"),
    "bob (proj-b) does NOT see the default-scope message (not leaked to global)",
  );
  await carol.cmd({ type: "logout" });
  carol.close();

  console.log("### DM ###");
  await alice.cmd({
    type: "send_message",
    text: "private hi",
    scope: "dm",
    target: "bob42",
  });
  await sleep(50);
  const bobCheckDm = await bob.cmd({ type: "check_messages" });
  await assert(
    bobCheckDm.messages.some((m) => m.scope === "dm" && m.text === "private hi"),
    "bob got DM",
  );

  console.log("### ask/answer ###");
  const aliceEventsBeforeAsk = alice.events.length;
  const askPromise = alice.cmd({
    type: "ask",
    target: "bob42",
    question: "what is 2+2?",
    timeout_seconds: 5,
  });
  await sleep(100);
  const bobAskCheck = await bob.cmd({ type: "check_messages" });
  const askMsg = bobAskCheck.messages.find((m) => m.ask_id);
  await assert(!!askMsg, "bob received ask message");
  const answerRes = await bob.cmd({
    type: "answer",
    correlation_id: askMsg.ask_id,
    text: "four",
  });
  console.log("answer ack:", answerRes);
  const askResult = await askPromise;
  console.log("ask result:", askResult);
  await assert(askResult.status === "answered" && askResult.text === "four", "ask got answer");
  // Asker should NOT also receive the reply DM on their event stream
  // (the ask() return already delivered it).
  const newAliceEvents = alice.events.slice(aliceEventsBeforeAsk);
  const sawReplyOnStream = newAliceEvents.some(
    (e) => e.data.in_reply_to_ask === askMsg.ask_id,
  );
  await assert(!sawReplyOnStream, "asker did NOT double-receive the reply on their stream");
  // And check_messages should also skip it (cursor was advanced).
  const aliceCheckAfter = await alice.cmd({ type: "check_messages" });
  const seenReplyViaFetch = aliceCheckAfter.messages.some(
    (m) => m.in_reply_to_ask === askMsg.ask_id,
  );
  await assert(!seenReplyViaFetch, "asker's check_messages did NOT return the reply either");

  console.log("### long-poll ###");
  const pollPromise = bob.cmd({ type: "check_messages", wait_seconds: 5 });
  await sleep(100);
  await alice.cmd({
    type: "send_message",
    text: "wake up!",
    scope: "dm",
    target: "bob42",
  });
  const polled = await pollPromise;
  await assert(
    polled.messages.some((m) => m.text === "wake up!"),
    "long-poll delivered",
  );

  console.log("### update_status ###");
  const updated = await alice.cmd({
    type: "update_status",
    status: "writing tests",
    username: "alice02",
  });
  await assert(updated.username === "alice02", "rename took effect");
  const list2 = await bob.cmd({ type: "list_agents" });
  await assert(
    list2.agents.some((a) => a.username === "alice02"),
    "bob sees rename",
  );

  console.log("### disconnect detection ###");
  bob.socket.destroy();
  await sleep(200);
  const list3 = await alice.cmd({ type: "list_agents" });
  console.log("after bob disconnect:", list3.agents.map((a) => a.username));
  await assert(list3.agents.length === 1, "bob auto-logged-out on disconnect");

  console.log("### logout ###");
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
