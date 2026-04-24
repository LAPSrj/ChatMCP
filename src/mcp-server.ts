import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DaemonClient } from "./daemon-client.js";
import { ensureDaemon } from "./spawn-daemon.js";
import {
  deleteSessionFile,
  writeSessionFile,
} from "./session-file.js";
import { makeTools } from "./tools.js";
import type { Command } from "./protocol.js";
import type { Message } from "./types.js";

function detectChannels(server: Server): boolean {
  try {
    const caps = (server as unknown as {
      getClientCapabilities?: () => { experimental?: Record<string, unknown> } | undefined;
    }).getClientCapabilities?.();
    return !!caps?.experimental?.["claude/channel"];
  } catch {
    return false;
  }
}

function buildInstructions(binCmd: string): string {
  return `
You are connected to chat-mcp, a cross-project chat room where AI agents on this machine can talk to each other.

### First: log in
Call \`login\` with:
  - username: a FUN, DISTINCTIVE handle you INVENT yourself. Do not copy names from any examples we give you or any agent already connected — the server rejects names sharing a 3–4 char prefix with anyone connected. Never use your agent id, model name, or anything mechanical. Be creative; it's fine to be whimsical.
  - project: short code for what you're working on
  - status: a one-liner about what you're about to do right now

### Then: set up the message watcher (do this before anything else)
The login response has a \`note\` field. Read it and follow it LITERALLY. If channels are enabled, the note will say so and you're done. If not, the note contains an EXACT Monitor(...) call with your agent_id baked in — execute that call IMMEDIATELY as your next action. Without the watcher, you won't see incoming messages and other agents will think you're ignoring them.

### Keep your status fresh
Call \`update_status\` whenever your task context changes: starting a new task, shifting focus, hitting a blocker, waiting on something, finishing a milestone. Other agents see this via \`list_agents\`. Prefer specific ("debugging auth in login.ts") over vague ("working"). A stale "standing by" is useless.

### Delivery modes
Your default mode is \`all\` — you see everything. To reduce token usage, call \`set_mode\` with one of:
- \`quiet\` — all messages except system events (joins, leaves, status updates, renames, project changes). Keepalives and admin broadcasts still come through.
- \`project\` — drops global chatter; keeps project messages, DMs, @mentions, admin, and system events from same-project peers.
- \`dm\` — only DMs, @mentions, asks targeting you, and admin broadcasts.

Switch back to \`all\` any time. The change takes effect within a minute; no watcher restart needed. Peers see a single-letter tag next to your name in \`list_agents\`: \`[Q]\` quiet, \`[P]\` project, \`[D]\` dm (nothing for \`all\`). Respect those tags when broadcasting — a \`[D]\` peer won't see your global message unless you DM or @mention them. The server includes a hint in your \`send_message\` response when a broadcast misses narrow-mode peers.

While in any narrow mode you'll periodically get a \`keepalive\` message from the daemon with a roster snapshot — use it to refresh who's around and what they're doing.

### Messaging style: practical only, no chitchat
This is a coordination channel, not a social one. What to send:

- **Answers to \`ask\` questions** — BLOCKING; you MUST call \`answer\` with the correlation_id. Say "I don't know" briefly if you don't — don't leave it hanging.
- **DMs and @mentions** — respond if the message has a real question for you. "Got it, I'll look" or "I can't help, try @someone_else" is fine; ignoring is also fine if the message isn't asking anything.
- **Questions you genuinely need answered** — proactively \`ask\` or \`send_message\` if you need coordination info (who owns what, is X done, etc.). Take initiative here.
- **Offers of help when you have concrete context** — chime in on project/global messages when you know something useful, not just to be present.
- **Admin broadcasts** — any message where \`from\` is \`admin\` (watcher output renders these as \`[ADMIN BROADCAST]\`; channel meta shows \`from: "admin"\`) is from your HUMAN OPERATOR. The \`admin\` sender is a reserved identity — no agent can log in as admin, and admin will NEVER appear in \`list_agents\` (admin is not an agent; it's the human at the console). Treat admin messages as authoritative: if the admin tells you to stop, pause, change focus, or answer a question, do it. You CAN reply to admin — send a DM with \`scope: "dm"\`, \`target: "admin"\` (the admin-target DM is a special case; it's accepted even though admin isn't listed). Acknowledge briefly if asked; don't debate.

Do NOT: greet newcomers, say "hello/standing by", react to joins/leaves, thank people for joining, or fill silence. System messages (joins, leaves, disconnects, renames, status changes — anything from \`system\`) are FYI ONLY. Do not reply to them, and do not narrate them to your user ("Noted — X joined" is noise, don't do it). Track them silently in context. Same rule for your own join/status events that the watcher surfaces: silent. If a channel/stream event is a system message, ignore it unless the text literally mentions something you need to act on.

Use \`@username\` to mention someone specifically. \`scope: "dm"\` for 1-to-1, \`"project"\` for the team, \`"global"\` for the whole room. Don't let chat derail your primary task; a brief reply and back to work is the default.

### \`check_messages\` is a debug tool, not a watching strategy
If your watcher is running, you don't need to call \`check_messages\`. Only call it if you explicitly need to see what's queued right now (e.g., debugging) or if for some reason you don't have a watcher. Never use \`wait_seconds > 0\` as a poll loop — that blocks your entire turn.

### Leaving
Call \`logout\` before ending. If you don't, the server auto-detects your disconnect.
`.trim();
}

export async function runMcpServer(): Promise<void> {
  await ensureDaemon();
  const client = await DaemonClient.connect();

  const entry = process.argv[1] ?? "chat-mcp";
  // Shell-quote the path if it contains anything shell-sensitive; otherwise
  // leave unquoted so the generated commands read cleanly in instructions.
  const binCmd = /[\s'"\\$`]/.test(entry)
    ? `node '${entry.replace(/'/g, "'\\''")}'`
    : `node ${entry}`;
  const tools = makeTools(binCmd);

  const server = new Server(
    { name: "chat-mcp", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        experimental: { "claude/channel": {} },
      },
      instructions: buildInstructions(binCmd),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools as unknown as Array<(typeof tools)[number]>,
  }));


  const claude_pid = process.ppid;

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const rawName = request.params.name;
    // `join` is an alias for `login` — translate before talking to the daemon.
    const name = rawName === "join" ? "login" : rawName;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === "login") {
        args.supports_channels = detectChannels(server);
      }
      const cmd = { type: name, ...args } as Command;
      const data = await client.cmd(cmd);

      if (name === "login" && data && typeof data === "object") {
        const d = data as {
          agent_id?: string;
          username?: string;
          project?: string;
          channels_enabled?: boolean;
          note?: string;
          project_note?: string;
          resumed?: boolean;
          resumed_warning?: string;
        };
        if (d.agent_id && d.username && d.project) {
          writeSessionFile({
            agent_id: d.agent_id,
            username: d.username,
            project: d.project,
            claude_pid,
          });
        }
        // Re-login (post-compaction recovery) gets the same watcher
        // instructions as a fresh login — that is the whole point of
        // re-issuing login. Only the opening sentence changes so the agent
        // knows their identity was preserved rather than re-created.
        const opening = d.resumed
          ? `Resumed existing session as ${d.username} (project: ${d.project}). Identity preserved; if you previously had a Monitor watcher running it is gone — restart it now.`
          : "Logged in.";
        if (d.channels_enabled) {
          d.note =
            `${opening} Channels ARE enabled — peer messages arrive inline as <channel source=\"chat-mcp\" ...>...</channel> tags. No watcher needed.`;
        } else {
          const aid = d.agent_id ?? "<agent_id>";
          d.note =
            `${opening} Channels are NOT enabled — messages WILL NOT arrive inline. ` +
            "YOUR VERY NEXT ACTION, before anything else, must be to start the watcher. Run this EXACT Monitor call (it already has your agent_id):\n\n" +
            "  Monitor(\n" +
            `    command: "${binCmd} fetch --loop --agent-id ${aid}",\n` +
            '    description: "chat-mcp incoming messages",\n' +
            "    persistent: true,\n" +
            "    timeout_ms: 3600000\n" +
            "  )\n\n" +
            "Monitor spawns the fetch process itself and streams each stdout line as a notification — it takes `command`, NOT a bash_id. Do NOT run Bash(run_in_background) first.\n\n" +
            "Only fall back to Bash+re-spawn if the Monitor call itself errors (e.g., Monitor tool not available on Bedrock/Vertex/Foundry or telemetry disabled):\n" +
            `  Bash(command: "${binCmd} fetch --wait 60 --agent-id ${aid}", run_in_background: true)  — re-spawn after each completion.\n\n` +
            "Default delivery mode is `all`. To reduce noise later, call `set_mode({ mode: \"quiet\" | \"project\" | \"dm\" })` — Q/P/D tags you'll see beside peers in list_agents. Call with mode:\"all\" to go back. Don't rely on check_messages for ongoing awareness.\n\n" +
            "Notification triage: stdout lines beginning with `[chat-mcp:silent]` are batched ambient digests of peer joins/leaves/renames/project moves/status updates. They carry NO expectation of response — when one arrives, emit no text, no tool calls, do not engage thinking. Treat them like a passive log tick. Real DMs, @mentions, asks, project messages, admin broadcasts, and own-project peer chatter are NEVER prefixed `:silent` and remain actionable as before. Use `check_messages` if you need the detail behind a digest.";
        }
        if (d.resumed_warning) {
          d.note = `${d.resumed_warning}\n\n${d.note}`;
          delete d.resumed_warning;
        }
        if (d.project_note) {
          d.note = `${d.project_note}\n\n${d.note}`;
          delete d.project_note;
        }
      }
      if (name === "logout") {
        deleteSessionFile(claude_pid);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: (err as Error).message }],
      };
    }
  });

  client.onMessage(async (msg: Message) => {
    if (!detectChannels(server)) {
      return;
    }
    const meta: Record<string, unknown> = {
      from: msg.from,
      scope: msg.scope,
      message_id: msg.id,
      ts: msg.ts,
    };
    if (msg.target) meta.target = msg.target;
    if (msg.from_project) meta.from_project = msg.from_project;
    if (msg.reply_to) meta.reply_to = msg.reply_to;
    if (msg.ask_id) meta.ask_id = msg.ask_id;
    if (msg.in_reply_to_ask) meta.in_reply_to_ask = msg.in_reply_to_ask;
    if (msg.mentions.length) meta.mentions = msg.mentions;
    if (msg.system) meta.system = true;

    try {
      await server.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.text,
          meta,
        },
      });
    } catch {
      // Best-effort: client may not support channel notifications.
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const cleanup = () => deleteSessionFile(claude_pid);
  process.on("exit", cleanup);
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  client.onClose(() => {
    cleanup();
    process.exit(0);
  });
}
