import { DaemonClient } from "./daemon-client.js";
import { ensureDaemon } from "./spawn-daemon.js";
import {
  readSessionFileByAncestor,
  type SessionFile,
} from "./session-file.js";
import type { Message, Mode } from "./types.js";

interface Options {
  wait: number;
  format: "text" | "json";
  rewake: boolean;
  limit: number;
  loop: boolean;
  agent_id: string | null;
}

function parseArgs(argv: string[]): Options {
  let wait = 60;
  let format: "text" | "json" = "text";
  let rewake = false;
  let limit = 50;
  let loop = false;
  let agent_id: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent-id") {
      const v = argv[++i];
      if (!v) throw new Error("--agent-id expects a value");
      agent_id = v;
    } else if (a === "--wait") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error("--wait expects a non-negative number");
      }
      wait = Math.min(n, 120);
    } else if (a === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error("--limit expects a positive integer");
      }
      limit = Math.min(n, 200);
    } else if (a === "--json") {
      format = "json";
    } else if (a === "--text") {
      format = "text";
    } else if (a === "--rewake") {
      rewake = true;
    } else if (a === "--loop") {
      loop = true;
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "chat-mcp fetch — drain pending chat messages for this Claude session\n\n" +
          "Designed to be spawned as a background task by an agent (via Bash with\n" +
          "run_in_background: true) when channel notifications aren't available.\n\n" +
          "Default (one-shot): returns after --wait N seconds or as soon as any\n" +
          "message arrives. Agent must re-spawn to keep watching.\n\n" +
          "With --loop: runs forever, emitting exactly one line per incoming\n" +
          "message. Designed to pair with Claude Code's Monitor tool, which\n" +
          "delivers each stdout line as a notification.\n\n" +
          "Delivery filtering — including quiet/project/dm modes and keepalive —\n" +
          "is owned by the daemon. Change your mode at any time via the set_mode\n" +
          "MCP tool; the watcher itself has no mode flags.\n\n" +
          "Options:\n" +
          "  --agent-id ID  Use this agent_id directly (from login response). Skips\n" +
          "                 session-file lookup — use this whenever possible, it's\n" +
          "                 more robust across sandboxes and process ancestry.\n" +
          "  --wait N       Wait up to N seconds for new messages (default 60, max 120)\n" +
          "  --limit N      Max messages per inner drain (default 50, max 200)\n" +
          "  --loop         Run indefinitely, one line per message (pair with Monitor)\n" +
          "  --json         Print JSON output (one-shot mode only)\n" +
          "  --text         Print human-readable text (default)\n" +
          "  --rewake       Exit code 2 on messages, 0 otherwise (for asyncRewake hooks)\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (loop && rewake) {
    throw new Error("--loop is incompatible with --rewake");
  }
  if (loop && format === "json") {
    throw new Error("--loop is incompatible with --json (one line per message is already structured)");
  }
  return { wait, format, rewake, limit, loop, agent_id };
}

export async function runFetch(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const session = resolveSession(opts);
  if (!session) {
    process.stderr.write(
      `chat-mcp fetch: no agent_id provided and no session file found in my process ancestry (starting from ppid=${process.ppid}).\n` +
        `Pass --agent-id <id> (from the chat-mcp login response), or run from a Claude session whose MCP server is logged in.\n`,
    );
    process.exit(opts.rewake ? 0 : 1);
    return;
  }

  if (opts.loop) {
    await runLoop(session, opts);
    return;
  }

  await runOneShot(session, opts);
}

function resolveSession(opts: Options): SessionFile | null {
  if (opts.agent_id) {
    return {
      agent_id: opts.agent_id,
      username: "(agent)",
      project: "",
      claude_pid: process.ppid,
      written_at: Date.now(),
    };
  }
  const found = readSessionFileByAncestor();
  return found ? found.session : null;
}

interface FetchResponse {
  agent: { username: string; project: string; mode: Mode } | null;
  messages: Message[];
  more: boolean;
  error?: string;
}

async function runOneShot(session: SessionFile, opts: Options): Promise<void> {
  await ensureDaemon();
  const client = await DaemonClient.connect();

  const result = (await client.cmd({
    type: "fetch_by_agent",
    agent_id: session.agent_id,
    wait_seconds: opts.wait,
    limit: opts.limit,
  })) as FetchResponse;

  if (result.error) {
    process.stderr.write(`chat-mcp fetch: ${result.error}\n`);
    process.exit(opts.rewake ? 0 : 1);
    return;
  }

  const username = result.agent?.username ?? session.username;

  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (result.messages.length === 0) {
    process.stdout.write(`No new chat messages for ${username}.\n`);
  } else {
    process.stdout.write(
      `New chat-mcp messages for ${username} (${result.messages.length}${
        result.more ? ", more pending" : ""
      }):\n`,
    );
    for (const m of result.messages) {
      process.stdout.write(formatMessage(m, { indent: true }) + "\n");
    }
    process.stdout.write(
      `\nReply with send_message (scope: dm/project/global) or answer if the message has ask_id.\n`,
    );
  }

  process.exit(opts.rewake && result.messages.length > 0 ? 2 : 0);
}

async function runLoop(session: SessionFile, opts: Options): Promise<void> {
  await ensureDaemon();
  const client = await DaemonClient.connect();

  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    process.exit(code);
  };
  process.on("SIGTERM", () => stop(0));
  process.on("SIGINT", () => stop(0));
  client.onClose(() => {
    process.stderr.write("chat-mcp fetch: daemon connection closed\n");
    stop(1);
  });

  // Preflight resolves the real username when launched with --agent-id (the
  // session stub carries "(agent)") and surfaces the current mode for the
  // startup banner. Any messages it returns are printed before the loop so
  // nothing is lost.
  const preflight = (await client.cmd({
    type: "fetch_by_agent",
    agent_id: session.agent_id,
    wait_seconds: 0,
    limit: opts.limit,
  })) as FetchResponse;
  if (preflight.error) {
    process.stderr.write(`chat-mcp fetch: ${preflight.error}\n`);
    stop(1);
    return;
  }

  const username = preflight.agent?.username ?? session.username;
  const project = preflight.agent?.project ?? session.project;
  const mode = preflight.agent?.mode ?? "all";
  const modeTag = mode === "all" ? "" : ` [mode=${mode}]`;
  process.stdout.write(
    `[chat-mcp] streaming messages for ${username} (project: ${project})${modeTag} — one line per message. Change mode via set_mode.\n`,
  );

  for (const m of preflight.messages) {
    await emitMessage(m);
  }

  while (!stopping) {
    const result = (await client.cmd({
      type: "fetch_by_agent",
      agent_id: session.agent_id,
      wait_seconds: Math.max(1, opts.wait),
      limit: opts.limit,
    })) as FetchResponse;

    if (result.error) {
      process.stderr.write(`chat-mcp fetch: ${result.error}\n`);
      stop(1);
      return;
    }

    for (const m of result.messages) {
      await emitMessage(m);
    }
  }
}

// Monitor batches stdout lines emitted within ~200ms into a single notification
// and truncates the batched notification at ~3KB (appending "...(truncated)").
// For long messages we wrap into many sub-400-char lines that all flush
// synchronously, so they land in one over-cap batch and get cut mid-sentence.
// To keep every notification intact, we yield a >200ms delay after each group
// of lines whose cumulative bytes approach the cap. The message arrives as
// multiple consecutive notifications instead of one truncated one.
const NOTIFICATION_FLUSH_BYTES = 2000;
const NOTIFICATION_FLUSH_MS = 250;

async function emitMessage(m: Message): Promise<void> {
  const lines = formatMessage(m, { indent: false }).split("\n");
  let pending = 0;
  for (const line of lines) {
    const chunk = line + "\n";
    if (pending > 0 && pending + chunk.length > NOTIFICATION_FLUSH_BYTES) {
      await new Promise((r) => setTimeout(r, NOTIFICATION_FLUSH_MS));
      pending = 0;
    }
    process.stdout.write(chunk);
    pending += chunk.length;
  }
}

// Max characters per stdout line. The Claude Code Monitor tool caps each
// streamed line around 500 chars and appends "...(truncated)". We emit the
// message header and then the body across as many wrapped lines as needed so
// no single line approaches that cap; Monitor batches lines emitted within
// 200ms into a single notification, so the message still arrives as one unit.
const MAX_LINE_CHARS = 400;

function wrapBody(text: string, indent: string): string[] {
  const inner = Math.max(20, MAX_LINE_CHARS - indent.length);
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= inner) {
      out.push(indent + rawLine);
      continue;
    }
    let rest = rawLine;
    while (rest.length > inner) {
      let brk = rest.lastIndexOf(" ", inner);
      if (brk <= 0) brk = inner;
      out.push(indent + rest.slice(0, brk));
      rest = rest.slice(brk).trimStart();
    }
    if (rest.length) out.push(indent + rest);
  }
  return out.length > 0 ? out : [indent];
}

export function formatMessage(m: Message, opts: { indent: boolean }): string {
  const when = new Date(m.ts).toLocaleTimeString("en-GB");
  let scope: string;
  if (m.scope === "global") scope = "*";
  else if (m.scope === "project") scope = `[${m.target}]`;
  else scope = `→${m.target}`;
  const prefix = opts.indent ? "  " : "";
  const bodyIndent = prefix + "    ";
  let header: string;
  if (m.from === "admin") {
    // Admin messages come from the human operator. Mark them so the agent
    // parses them as authoritative rather than another peer chat.
    header = `${prefix}${when} ${scope} [ADMIN BROADCAST]`;
  } else if (m.system_kind === "keepalive") {
    header = `${prefix}${when} · keepalive`;
  } else {
    const who = m.system ? "system" : m.from;
    const proj = m.from_project ? `(${m.from_project})` : "";
    const ask = m.ask_id
      ? ` [ask_id=${m.ask_id}]`
      : m.in_reply_to_ask
        ? ` [answering ask_id=${m.in_reply_to_ask}]`
        : "";
    const mentions = m.mentions.length
      ? ` [mentions: ${m.mentions.join(", ")}]`
      : "";
    const reply = m.reply_to ? ` [reply_to=${m.reply_to}]` : "";
    header = `${prefix}${when} ${scope} ${who}${proj}${ask}${reply}${mentions}:`;
  }
  return [header, ...wrapBody(m.text, bodyIndent)].join("\n");
}
