// Modes smoke — exercises set_mode plus the server-side filter.
//
// Covers:
//   1. Default mode is "all" — everything delivered.
//   2. set_mode({ mode: "quiet" }) drops system events, keeps real chat.
//   3. set_mode({ mode: "project" }) drops global chatter from outside
//      the project but keeps project scope + same-project system events.
//   4. set_mode({ mode: "dm" }) drops everything except personal
//      (DMs, @mentions, admin, asks).
//   5. Cursor advances past filtered messages — flipping back to "all"
//      does not replay stale chatter.
//   6. set_mode is reflected in list_agents (mode field).
//   7. Broadcast miss hint lists narrow-mode peers grouped by mode.
//   8. Daemon keepalive sweeper emits a synthetic keepalive DM with a
//      roster body to idle non-channels agents.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const BIN = path.resolve("dist/bin.js");
const STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "chat-mcp-modes-smoke-"));
const ENV = {
  ...process.env,
  XDG_STATE_HOME: STATE_HOME,
  // Sub-minute keepalive so the idle-sweep branch fires quickly in tests.
  CHAT_MCP_KEEPALIVE_MINUTES: "0.05",
};
const SOCKET = path.join(STATE_HOME, "chat-mcp", "chat.sock");

process.on("exit", () => {
  try {
    fs.rmSync(STATE_HOME, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

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
  // Drain pending messages via fetch_by_agent (wait=0) and return them.
  async drain() {
    const out = [];
    for (;;) {
      const r = await this.cmd({
        type: "fetch_by_agent",
        agent_id: this.agent_id,
        wait_seconds: 0,
        limit: 200,
      });
      if (r.error) throw new Error(r.error);
      out.push(...r.messages);
      if (!r.more) return out;
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnDaemon() {
  const proc = spawn(process.execPath, [BIN, "--daemon"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: ENV,
  });
  proc.stderr.on("data", () => {});
  return proc;
}

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
    await sleep(50);
  }
  throw new Error("daemon socket didn't come up");
}

async function main() {
  const daemon = spawnDaemon();
  try {
    await waitForSocket();
  } catch (err) {
    daemon.kill();
    throw err;
  }

  // Three peers: alice cycles modes, bob sends from her project, carol
  // sends from a different project (to exercise project-mode filtering).
  const alice = new Peer();
  await alice.ready;
  const aliceLogin = await alice.cmd({
    type: "login",
    username: "alizarin",
    project: "proj-a",
    status: "mode test subject",
  });
  alice.agent_id = aliceLogin.agent_id;

  const bob = new Peer();
  await bob.ready;
  await bob.cmd({
    type: "login",
    username: "bozo-plume",
    project: "proj-a",
    status: "sender",
  });

  const carol = new Peer();
  await carol.ready;
  await carol.cmd({
    type: "login",
    username: "xerxesCurio",
    project: "proj-b",
    status: "cross-project sender",
  });

  // Drain the join messages so assertions below start from a clean slate.
  await alice.drain();

  // --- Test 1: default mode is "all". ------------------------------------
  let roster = await bob.cmd({ type: "list_agents" });
  if (roster.agents.find((a) => a.username === "alizarin")?.mode !== "all") {
    throw new Error(
      "default mode should be all; got " +
        JSON.stringify(roster.agents.find((a) => a.username === "alizarin")),
    );
  }
  console.log("ok: default mode is 'all' in list_agents");

  await bob.cmd({
    type: "send_message",
    text: "global from bob (all-mode test)",
    scope: "global",
  });
  await bob.cmd({
    type: "send_message",
    text: "project from bob (all-mode test)",
    scope: "project",
    target: "proj-a",
  });
  await carol.cmd({
    type: "update_status",
    status: "status update from carol — should reach all-mode peers",
  });
  let got = await alice.drain();
  if (!got.some((m) => m.text.includes("global from bob"))) {
    throw new Error("all mode missed bob's global");
  }
  if (!got.some((m) => m.text.includes("project from bob"))) {
    throw new Error("all mode missed bob's project message");
  }
  if (!got.some((m) => m.system_kind === "status" && m.system_actor === "xerxesCurio")) {
    throw new Error("all mode missed carol's status update (system event)");
  }
  console.log("ok: mode=all delivers everything");

  // --- Test 2: quiet drops system events. --------------------------------
  const quietResp = await alice.cmd({ type: "set_mode", mode: "quiet" });
  if (quietResp.mode !== "quiet") {
    throw new Error("set_mode did not return quiet: " + JSON.stringify(quietResp));
  }
  roster = await bob.cmd({ type: "list_agents" });
  if (roster.agents.find((a) => a.username === "alizarin")?.mode !== "quiet") {
    throw new Error("list_agents doesn't reflect quiet mode");
  }
  console.log("ok: set_mode -> quiet, reflected in list_agents");

  await carol.cmd({
    type: "update_status",
    status: "carol status #2 — quiet-mode alice should NOT see this",
  });
  await bob.cmd({
    type: "send_message",
    text: "quiet-mode: bob global message should arrive",
    scope: "global",
  });
  got = await alice.drain();
  if (got.some((m) => m.system === true && m.system_kind === "status")) {
    throw new Error("quiet mode leaked a system status event");
  }
  if (!got.some((m) => m.text.includes("quiet-mode: bob global"))) {
    throw new Error("quiet mode dropped a regular global message");
  }
  console.log("ok: mode=quiet drops system events, keeps real chat");

  // --- Test 3: project mode filters by project. --------------------------
  await alice.cmd({ type: "set_mode", mode: "project" });
  await carol.cmd({
    type: "send_message",
    text: "global from carol (proj-b) — project-mode alice should NOT see this",
    scope: "global",
  });
  await bob.cmd({
    type: "send_message",
    text: "proj-a scope — project-mode alice SHOULD see this",
    scope: "project",
    target: "proj-a",
  });
  await bob.cmd({
    type: "update_status",
    status: "bob status — same-project system event, should arrive",
  });
  await carol.cmd({
    type: "update_status",
    status: "carol status — cross-project system event, should NOT arrive",
  });
  got = await alice.drain();
  if (got.some((m) => m.text.includes("global from carol"))) {
    throw new Error("project mode leaked a cross-project global");
  }
  if (!got.some((m) => m.text.includes("proj-a scope"))) {
    throw new Error("project mode dropped a same-project message");
  }
  if (!got.some((m) => m.system_kind === "status" && m.from_project === "proj-a")) {
    throw new Error("project mode dropped a same-project system event");
  }
  if (got.some((m) => m.system_kind === "status" && m.from_project === "proj-b")) {
    throw new Error("project mode leaked a cross-project system event");
  }
  console.log("ok: mode=project scopes correctly");

  // --- Test 4: dm mode passes only personal + admin. --------------------
  await alice.cmd({ type: "set_mode", mode: "dm" });
  await bob.cmd({
    type: "send_message",
    text: "dm-mode: bob global chatter",
    scope: "global",
  });
  await bob.cmd({
    type: "send_message",
    text: "dm-mode: bob project chatter",
    scope: "project",
    target: "proj-a",
  });
  await bob.cmd({
    type: "send_message",
    text: "dm-mode: hey @alizarin please check this",
    scope: "global",
  });
  await bob.cmd({
    type: "send_message",
    text: "dm-mode: direct message for alice",
    scope: "dm",
    target: "alizarin",
  });
  got = await alice.drain();
  if (got.some((m) => m.text.includes("bob global chatter"))) {
    throw new Error("dm mode leaked a global broadcast");
  }
  if (got.some((m) => m.text.includes("bob project chatter"))) {
    throw new Error("dm mode leaked a project broadcast");
  }
  if (!got.some((m) => m.text.includes("hey @alizarin"))) {
    throw new Error("dm mode dropped an @mention");
  }
  if (!got.some((m) => m.text.includes("direct message for alice"))) {
    throw new Error("dm mode dropped a DM");
  }
  console.log("ok: mode=dm drops broadcasts, keeps personal");

  // --- Test 5: no replay when flipping back to all. ----------------------
  await alice.cmd({ type: "set_mode", mode: "all" });
  got = await alice.drain();
  const leaked = got.filter(
    (m) =>
      m.text.includes("dm-mode: bob global") ||
      m.text.includes("dm-mode: bob project") ||
      m.text.includes("global from carol (proj-b)") ||
      (m.system_kind === "status" &&
        m.from_project === "proj-b" &&
        m.text.includes("carol status")),
  );
  if (leaked.length > 0) {
    throw new Error(
      "mode flip replayed filtered messages: " +
        JSON.stringify(leaked.map((m) => m.text)),
    );
  }
  console.log("ok: mode flip doesn't replay filtered messages");

  // --- Test 6: narrow-mode miss hint. ------------------------------------
  await alice.cmd({ type: "set_mode", mode: "dm" });
  const sendResp = await bob.cmd({
    type: "send_message",
    text: "hint-test global — no mention of alice",
    scope: "global",
  });
  if (
    !sendResp.hints ||
    !sendResp.hints.some(
      (h) =>
        h.includes("narrow mode") && h.includes("alizarin") && h.includes("dm"),
    )
  ) {
    throw new Error(
      "expected narrow-mode miss hint listing alizarin(dm); got hints=" +
        JSON.stringify(sendResp.hints),
    );
  }
  console.log("ok: broadcast miss hint lists narrow-mode peers");
  await alice.cmd({ type: "set_mode", mode: "all" });

  // --- Test 7: keepalive sweep. -----------------------------------------
  // Daemon sweeper runs every 30s. Drain everything, then block in a single
  // long wait_seconds so we stay idle past the sweep + the configured
  // keepalive threshold. Smoke runs ~35s during this step.
  await alice.drain();
  console.log("  (waiting ~35s for the daemon keepalive sweep...)");
  const waitResp = await alice.cmd({
    type: "fetch_by_agent",
    agent_id: alice.agent_id,
    wait_seconds: 40,
    limit: 10,
  });
  if (waitResp.error) {
    throw new Error("keepalive fetch errored: " + waitResp.error);
  }
  const keepalive = waitResp.messages.find((m) => m.system_kind === "keepalive");
  if (!keepalive) {
    throw new Error(
      "no keepalive message delivered after idle sweep; messages=" +
        JSON.stringify(waitResp.messages.map((m) => m.text.slice(0, 40))),
    );
  }
  if (!keepalive.text.includes("keepalive")) {
    throw new Error("keepalive body missing expected header: " + keepalive.text);
  }
  if (!keepalive.text.includes("alizarin")) {
    throw new Error("keepalive body missing roster entry for alizarin");
  }
  console.log("ok: keepalive message delivered with roster snapshot");

  // Teardown.
  await bob.cmd({ type: "logout" }).catch(() => {});
  await carol.cmd({ type: "logout" }).catch(() => {});
  await alice.cmd({ type: "logout" }).catch(() => {});
  alice.close();
  bob.close();
  carol.close();
  daemon.kill("SIGTERM");
  await new Promise((r) => daemon.once("exit", r)).catch(() => {});
  console.log("ALL GOOD");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
