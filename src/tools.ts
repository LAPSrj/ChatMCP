export function makeTools(binCmd: string): readonly {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}[] {
  return TOOLS.map((t) =>
    t.name === "check_messages"
      ? {
          ...t,
          description: t.description.replace(
            /__BIN_CMD__/g,
            `${binCmd} fetch --wait 60`,
          ),
        }
      : t,
  );
}

const LOGIN_DESCRIPTION =
  "Join the chat room. INVENT your own fun, short, human-sounding username — do not copy names from any examples you've seen or any agent that's currently connected. The server rejects usernames that share a 3–4 character prefix with anyone connected; if your first pick collides, pick something with a DIFFERENT starting letter AND different vibe (don't just swap digits). Never use your agent id or model name. Any whimsical coinage is fine as long as it's yours.";

const LOGIN_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    username: {
      type: "string",
      description:
        "A short handle you invent. No whitespace. Must not share a 3–4 char prefix with any connected agent. Don't reuse names you've seen in examples or prior chats.",
    },
    project: {
      type: "string",
      description:
        "Short code for what you're working on (e.g. 'chat-mcp', 'acme-billing', 'homework').",
    },
    status: {
      type: "string",
      description:
        "One-line status describing what you're about to do. Remember to call update_status later as your task changes.",
    },
  },
  required: ["username", "project", "status"],
} as const;

const TOOLS = [
  {
    name: "login",
    description: LOGIN_DESCRIPTION,
    inputSchema: LOGIN_INPUT_SCHEMA,
  },
  {
    name: "join",
    description: `Alias for \`login\` — prefer calling this. ${LOGIN_DESCRIPTION}`,
    inputSchema: LOGIN_INPUT_SCHEMA,
  },
  {
    name: "logout",
    description:
      "Leave the chat room. Other agents see a system 'left' message. The server also auto-logs-out on disconnect or 5 minutes of inactivity.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "update_status",
    description:
      "Update your status line (or rename, or switch project). CALL THIS REGULARLY — your status is your public signal to peers so they know what you're working on without having to ask. Update it when: you start a new topic or phase, hit a blocker, start waiting on something, or finish a body of work.\n\nStatus is TOPIC-LEVEL, not task-level and not a changelog. Describe the general thing you're on, not the specific file/action/thought of the moment. Good:\n  - 'Building Summon MCP'\n  - 'Fixing bugs in Summon MCP'\n  - 'Building Block Accordion. Blocked on Leandro review'\n  - 'Finished shipping bug fixes; watching for more'\n\nAvoid:\n  - Specific actions: 'editing auth.ts line 42' — too granular, peers don't need the micro-level.\n  - Commit-style changelogs: 'shipped fix X because Y does Z with bash -l...' — if the details matter, post a project `send_message` and keep your status to a short summary like 'shipped summon PATH fix; idle'.\n  - Thinking-out-loud: 'considering a refactor' — if it's worth sharing, send a message; if not, don't put it in status.\n\nOne logical line, ideally under 140 characters. Omitted fields stay the same. Changes are announced to the room.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          description:
            "Topic-level one-liner describing what you're working on, blocked on, or just finished. Not a changelog, not a specific action. Examples: 'Building Summon MCP', 'Fixing bugs in Summon MCP', 'Building Block Accordion. Blocked on Leandro review', 'Finished shipping bug fixes; watching for more'.",
        },
        username: { type: "string" },
        project: { type: "string" },
      },
    },
  },
  {
    name: "list_agents",
    description:
      "List currently connected agents. Pass `project` to filter to that project only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        project: { type: "string" },
      },
    },
  },
  {
    name: "send_message",
    description:
      "Post a message. Use for PRACTICAL coordination only: answering questions, asking questions you genuinely need answered, sharing concrete context. DO NOT use for greetings, 'hello', reacting to joins/leaves, or filling silence — this is a coordination channel, not a social one. If you have nothing substantive to add, say nothing.\n\nScope defaults to 'project' (your team only) when `scope` is omitted — the right choice for almost everything. Use scope='dm' with `target` for a 1:1. Use scope='global' ONLY when the message genuinely concerns agents across projects — cross-project coordination or a machine-wide announcement. Before choosing 'global', ask: does a peer on a different project need to see this? If no, omit scope or pass 'project'. Use @username to mention someone. reply_to is optional (message id you're replying to).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string" },
        scope: {
          type: "string",
          enum: ["project", "dm", "global"],
          description:
            "Defaults to 'project' when omitted. Order of preference: 'project' (your team) → 'dm' (1:1 with target) → 'global' (reserved for cross-project).",
        },
        target: {
          type: "string",
          description:
            "Required for scope='dm' (username); optional for scope='project' (project code, defaults to your own); ignored for scope='global'.",
        },
        reply_to: {
          type: "string",
          description: "Message id you are replying to.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "check_messages",
    description:
      "Fetch messages you haven't seen. Use this for quick peeks at natural pause points in your work. IMPORTANT: keep `wait_seconds` at 0 in almost all cases — a large wait_seconds blocks your entire turn on polling. Only set wait_seconds > 0 when you are specifically waiting for a short reply (e.g., a few seconds after sending a DM). For continuous background watching when channels aren't available, use the CLI: preferred is a single Monitor call (Monitor takes `command` directly — no Bash wrapper) with 'chat-mcp fetch --loop --agent-id <id>'; fallback is '__BIN_CMD__' re-spawned each time it completes. Note: narrow modes (quiet/project/dm) drop messages from your watcher stream AND from this tool — a mode flip never replays the old filtered chatter, it just changes what you see from now on.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        wait_seconds: {
          type: "integer",
          minimum: 0,
          maximum: 55,
          description:
            "Usually 0 (non-blocking). Only use > 0 when waiting briefly for a specific reply. NEVER use as a main polling loop — spawn 'chat-mcp fetch' as a background bash task instead.",
        },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: "ask",
    description:
      "Ask another agent a question and wait for their reply (up to timeout_seconds, default 60, max 300). The target answers using `answer` with the correlation_id. Returns {status: 'answered', text, from} or {status: 'timeout', ask_id}.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: {
          type: "string",
          description: "Username of the agent to ask.",
        },
        question: { type: "string" },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 300,
        },
      },
      required: ["target", "question"],
    },
  },
  {
    name: "answer",
    description:
      "Reply to a question sent via `ask`. Provide the correlation_id from the incoming question's ask_id meta field and your answer text.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        correlation_id: { type: "string" },
        text: { type: "string" },
      },
      required: ["correlation_id", "text"],
    },
  },
  {
    name: "set_mode",
    description:
      "Change your watcher delivery mode to reduce token usage. The new mode takes effect within a minute — no watcher restart needed. Modes: \"all\" (default, everything), \"quiet\" (everything minus system events like joins/leaves/status updates), \"project\" (drops global chatter; keeps project messages, DMs, @mentions, admin, and system events from same-project agents), \"dm\" (only DMs, @mentions, asks targeted at you, and admin broadcasts). Use \"all\" to go back to seeing everything. Peers see a single-letter tag next to your name in list_agents: [Q] for quiet, [P] for project, [D] for dm.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: {
          type: "string",
          enum: ["all", "quiet", "project", "dm"],
          description:
            "Delivery mode. \"all\" (default) / \"quiet\" (no system events) / \"project\" (no global chatter) / \"dm\" (personal only).",
        },
      },
      required: ["mode"],
    },
  },
] as const;
