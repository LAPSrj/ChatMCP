import { randomUUID } from "node:crypto";
import type { State } from "./state.js";
import type { Command } from "./protocol.js";
import type { Agent, Message, Mode } from "./types.js";
import { isMode } from "./types.js";

const STATUS_STALE_MS = 15 * 60 * 1000;

function staleStatusHint(agent: Agent): string | null {
  const age = Date.now() - agent.status_updated_at;
  if (age < STATUS_STALE_MS) return null;
  const mins = Math.floor(age / 60000);
  return `Your status hasn't changed in ${mins}m — call update_status so other agents know what you're doing (specific, not "standing by").`;
}

function narrowModeMissHint(
  ctx: HandlerContext,
  msg: Message,
  sender: string,
): string | null {
  if (msg.scope !== "global" && msg.scope !== "project") return null;
  const mentionSet = new Set(msg.mentions.map((m) => m.toLowerCase()));
  const missed: { username: string; mode: Mode }[] = [];
  for (const a of ctx.state.listAgents()) {
    if (a.username === sender) continue;
    if (msg.scope === "project" && a.project !== msg.target) continue;
    if (mentionSet.has(a.username.toLowerCase())) continue;
    // quiet never drops broadcasts; all sees everything. Only dm and project
    // miss broad chatter — and project only misses global, not project.
    if (a.mode === "dm") missed.push({ username: a.username, mode: a.mode });
    else if (a.mode === "project" && msg.scope === "global")
      missed.push({ username: a.username, mode: a.mode });
  }
  if (missed.length === 0) return null;
  const byMode = new Map<Mode, string[]>();
  for (const m of missed) {
    const list = byMode.get(m.mode);
    if (list) list.push(m.username);
    else byMode.set(m.mode, [m.username]);
  }
  const parts: string[] = [];
  for (const [mode, names] of byMode) {
    const show = names.slice(0, 4).join(", ");
    const more = names.length > 4 ? ` +${names.length - 4}` : "";
    parts.push(`${mode}: ${show}${more}`);
  }
  return `${missed.length} peer(s) with narrow mode (${parts.join("; ")}) won't be notified by this ${msg.scope} message. DM or @mention them if you need their attention.`;
}

function singleMentionDmHint(
  ctx: HandlerContext,
  scope: "global" | "project" | "dm",
  text: string,
  mentions: string[],
): string | null {
  if (scope === "dm") return null;
  if (mentions.length !== 1) return null;
  const mention = mentions[0];
  const trimmed = text.trimStart();
  if (!trimmed.toLowerCase().startsWith(`@${mention.toLowerCase()}`)) return null;
  const isAdmin = mention.toLowerCase() === "admin";
  if (!isAdmin && !ctx.state.getAgentByUsername(mention)) return null;
  return `This looks like a 1:1 to @${mention} — next time use send_message with scope:"dm", target:"${mention}" so you don't spam the whole ${scope === "global" ? "room" : "project"}.`;
}

export interface Session {
  agent_id: string | null;
}

export interface HandlerContext {
  state: State;
  session: Session;
  /** Invoked synchronously when a message is created via addMessage. */
  onMessageCreated?: (msg: Message) => void;
}

export async function handle(
  ctx: HandlerContext,
  cmd: Command,
): Promise<unknown> {
  switch (cmd.type) {
    case "login":
      return login(ctx, cmd);
    case "logout":
      return logout(ctx);
    case "update_status":
      return updateStatus(ctx, cmd);
    case "list_agents":
      return listAgents(ctx, cmd);
    case "send_message":
      return sendMessage(ctx, cmd);
    case "check_messages":
      return checkMessages(ctx, cmd);
    case "ask":
      return ask(ctx, cmd);
    case "answer":
      return answer(ctx, cmd);
    case "monitor":
      return monitor(ctx, cmd);
    case "fetch_by_agent":
      return fetchByAgent(ctx, cmd);
    case "set_mode":
      return setMode(ctx, cmd);
    case "admin_broadcast":
      return adminBroadcast(ctx, cmd);
  }
}

function setMode(
  ctx: HandlerContext,
  cmd: Extract<Command, { type: "set_mode" }>,
): unknown {
  if (!ctx.session.agent_id) throw new Error("Not logged in.");
  if (!isMode(cmd.mode)) {
    throw new Error(
      `Invalid mode "${String(cmd.mode)}". Allowed: all, quiet, project, dm.`,
    );
  }
  const agent = ctx.state.setMode(ctx.session.agent_id, cmd.mode);
  if (!agent) throw new Error("Session agent not found.");
  ctx.state.touchAgent(agent.id);
  return { mode: agent.mode };
}

function adminBroadcast(
  ctx: HandlerContext,
  cmd: Extract<Command, { type: "admin_broadcast" }>,
): unknown {
  if (!cmd.text || !cmd.text.trim()) throw new Error("Message text is empty.");
  let target: string | undefined;
  let target_project: string | undefined;
  if (cmd.scope === "dm") {
    if (!cmd.target) throw new Error("DM requires a target username.");
    const targetAgent = ctx.state.getAgentByUsername(cmd.target);
    if (!targetAgent) {
      throw new Error(`No agent is logged in as "${cmd.target}".`);
    }
    target = cmd.target;
    target_project = targetAgent.project;
  } else if (cmd.scope === "project") {
    if (!cmd.target) {
      throw new Error("project scope requires a target project code.");
    }
    target = cmd.target;
  } else if (cmd.scope === "global") {
    target = undefined;
  } else {
    throw new Error(
      `Unknown scope: ${String((cmd as { scope?: string }).scope)}`,
    );
  }
  const msg = ctx.state.addMessage(
    {
      from: "admin",
      scope: cmd.scope,
      target,
      target_project,
      text: cmd.text,
      reply_to: cmd.reply_to,
    },
    ctx.onMessageCreated,
  );
  return {
    message_id: msg.id,
    seq: msg.seq,
    mentions: msg.mentions,
    delivered_to: countRecipients(ctx, cmd.scope, target, "admin"),
  };
}

async function fetchByAgent(
  ctx: HandlerContext,
  cmd: Extract<Command, { type: "fetch_by_agent" }>,
): Promise<unknown> {
  const agent = ctx.state.getAgent(cmd.agent_id);
  if (!agent) {
    return {
      agent: null,
      messages: [],
      more: false,
      error:
        "Session expired — this agent_id is no longer connected. Log in again.",
    };
  }
  ctx.state.touchAgent(agent.id);
  const wait = Math.max(0, Math.min(cmd.wait_seconds ?? 0, 120));
  const limit = Math.max(1, Math.min(cmd.limit ?? 50, 200));

  const first = ctx.state.takeMessages(agent.id, limit);
  if (first.messages.length > 0 || wait === 0) {
    return {
      agent: {
        username: agent.username,
        project: agent.project,
        mode: agent.mode,
      },
      messages: first.messages,
      more: first.more,
    };
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const unsub = ctx.state.onMessage(agent.id, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve();
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsub();
      resolve();
    }, wait * 1000);
  });

  const after = ctx.state.takeMessages(agent.id, limit);
  return {
    agent: {
      username: agent.username,
      project: agent.project,
      mode: agent.mode,
    },
    messages: after.messages,
    more: after.more,
  };
}

function monitor(
  ctx: HandlerContext,
  cmd: Extract<Command, { type: "monitor" }>,
): unknown {
  const tail = Math.max(0, Math.min(cmd.tail ?? 0, 500));
  return {
    ok: true,
    note: "Subscribed to all messages (read-only).",
    history: tail > 0 ? ctx.state.recentMessages(tail) : [],
  };
}

function login(
  ctx: HandlerContext,
  cmd: Extract<Command, { type: "login" }>,
): unknown {
  if (ctx.session.agent_id) {
    const a = ctx.state.getAgent(ctx.session.agent_id);
    throw new Error(
      `Already logged in as "${a?.username}". Call logout first if you want to change identity.`,
    );
  }
  const agent = ctx.state.createAgent(
    cmd.username,
    cmd.project,
    cmd.status,
    cmd.supports_channels ?? false,
  );
  ctx.session.agent_id = agent.id;
  ctx.state.addMessage(
    {
      from: "system",
      from_project: agent.project,
      scope: "global",
      text: `${agent.username} joined (${agent.project})${
        agent.status ? ` — ${agent.status}` : ""
      }`,
      system: true,
      system_kind: "join",
      system_actor: agent.username,
      not_for: agent.id,
    },
    ctx.onMessageCreated,
  );
  return {
    agent_id: agent.id,
    username: agent.username,
    project: agent.project,
    status: agent.status,
    channels_enabled: agent.supports_channels,
  };
}

function logout(ctx: HandlerContext): unknown {
  if (!ctx.session.agent_id) throw new Error("Not logged in.");
  const agent = ctx.state.removeAgent(ctx.session.agent_id);
  ctx.session.agent_id = null;
  if (agent) {
    ctx.state.addMessage(
      {
        from: "system",
        from_project: agent.project,
        scope: "global",
        text: `${agent.username} left`,
        system: true,
        system_kind: "leave",
        system_actor: agent.username,
      },
      ctx.onMessageCreated,
    );
  }
  return { ok: true };
}

function updateStatus(
  ctx: HandlerContext,
  cmd: Extract<Command, { type: "update_status" }>,
): unknown {
  if (!ctx.session.agent_id) throw new Error("Not logged in.");
  const prev = ctx.state.getAgent(ctx.session.agent_id);
  if (!prev) throw new Error("Session agent not found.");
  const before = {
    username: prev.username,
    project: prev.project,
    status: prev.status,
  };
  const agent = ctx.state.updateAgent(ctx.session.agent_id, {
    status: cmd.status,
    username: cmd.username,
    project: cmd.project,
  });
  if (before.username !== agent.username) {
    ctx.state.addMessage(
      {
        from: "system",
        from_project: agent.project,
        scope: "global",
        text: `${before.username} is now ${agent.username}`,
        system: true,
        system_kind: "rename",
        system_actor: agent.username,
        not_for: agent.id,
      },
      ctx.onMessageCreated,
    );
  }
  if (before.project !== agent.project) {
    ctx.state.addMessage(
      {
        from: "system",
        from_project: agent.project,
        scope: "global",
        text: `${agent.username} moved to project ${agent.project}`,
        system: true,
        system_kind: "project_change",
        system_actor: agent.username,
        not_for: agent.id,
      },
      ctx.onMessageCreated,
    );
  }
  if (before.status !== agent.status) {
    ctx.state.addMessage(
      {
        from: "system",
        from_project: agent.project,
        scope: "global",
        text: agent.status || "(cleared)",
        system: true,
        system_kind: "status",
        system_actor: agent.username,
        not_for: agent.id,
      },
      ctx.onMessageCreated,
    );
  }
  return {
    username: agent.username,
    project: agent.project,
    status: agent.status,
  };
}

function listAgents(
  ctx: HandlerContext,
  cmd: Extract<Command, { type: "list_agents" }>,
): unknown {
  if (ctx.session.agent_id) ctx.state.touchAgent(ctx.session.agent_id);
  return { agents: ctx.state.listAgents(cmd.project) };
}

function sendMessage(
  ctx: HandlerContext,
  cmd: Extract<Command, { type: "send_message" }>,
): unknown {
  if (!ctx.session.agent_id) throw new Error("Not logged in.");
  const agent = ctx.state.getAgent(ctx.session.agent_id);
  if (!agent) throw new Error("Session agent not found.");
  ctx.state.touchAgent(agent.id);
  if (!cmd.text || !cmd.text.trim()) {
    throw new Error("Message text is empty.");
  }
  // Scope defaults to "project" — the vast majority of peer chatter is
  // project-internal, and making the narrower scope the default prevents
  // accidental global pollution. Going cross-project requires an explicit
  // scope: "global".
  const scope = cmd.scope ?? "project";
  let target: string | undefined;
  let target_project: string | undefined;
  if (scope === "dm") {
    if (!cmd.target) throw new Error("DM requires a target username.");
    // "admin" is reserved — accept it as a DM target even though no agent is
    // logged in under that name. The admin console receives these via its
    // monitor subscription.
    if (cmd.target.toLowerCase() === "admin") {
      target = cmd.target;
    } else {
      const targetAgent = ctx.state.getAgentByUsername(cmd.target);
      if (!targetAgent) {
        throw new Error(`No agent is logged in as "${cmd.target}".`);
      }
      target = cmd.target;
      target_project = targetAgent.project;
    }
  } else if (scope === "project") {
    target = cmd.target ?? agent.project;
  } else if (scope === "global") {
    target = undefined;
  } else {
    throw new Error(`Unknown scope: ${String(scope)}`);
  }
  const msg = ctx.state.addMessage(
    {
      from: agent.username,
      from_project: agent.project,
      scope,
      target,
      target_project,
      text: cmd.text,
      reply_to: cmd.reply_to,
    },
    ctx.onMessageCreated,
  );
  const hints: string[] = [];
  const dmHint = singleMentionDmHint(ctx, msg.scope, msg.text, msg.mentions);
  if (dmHint) hints.push(dmHint);
  const missHint = narrowModeMissHint(ctx, msg, agent.username);
  if (missHint) hints.push(missHint);
  const statusHint = staleStatusHint(agent);
  if (statusHint) hints.push(statusHint);
  return {
    message_id: msg.id,
    seq: msg.seq,
    mentions: msg.mentions,
    delivered_to: countRecipients(ctx, msg.scope, target, agent.username),
    ...(hints.length ? { hints } : {}),
  };
}

function countRecipients(
  ctx: HandlerContext,
  scope: "global" | "project" | "dm",
  target: string | undefined,
  sender: string,
): number {
  let count = 0;
  for (const a of ctx.state.listAgents()) {
    if (a.username === sender) continue;
    if (scope === "global") count++;
    else if (scope === "project" && a.project === target) count++;
    else if (scope === "dm" && a.username === target) count++;
  }
  return count;
}

async function checkMessages(
  ctx: HandlerContext,
  cmd: Extract<Command, { type: "check_messages" }>,
): Promise<unknown> {
  if (!ctx.session.agent_id) throw new Error("Not logged in.");
  const agent_id = ctx.session.agent_id;
  ctx.state.touchAgent(agent_id);
  const wait = Math.max(0, Math.min(cmd.wait_seconds ?? 0, 55));
  const limit = Math.max(1, Math.min(cmd.limit ?? 50, 200));

  const first = ctx.state.takeMessages(agent_id, limit);
  if (first.messages.length > 0 || wait === 0) {
    return { messages: first.messages, more: first.more };
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const unsubscribe = ctx.state.onMessage(agent_id, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve();
    }, wait * 1000);
  });

  const after = ctx.state.takeMessages(agent_id, limit);
  return { messages: after.messages, more: after.more };
}

async function ask(
  ctx: HandlerContext,
  cmd: Extract<Command, { type: "ask" }>,
): Promise<unknown> {
  if (!ctx.session.agent_id) throw new Error("Not logged in.");
  const agent = ctx.state.getAgent(ctx.session.agent_id);
  if (!agent) throw new Error("Session agent not found.");
  ctx.state.touchAgent(agent.id);
  const target = ctx.state.getAgentByUsername(cmd.target);
  if (!target) throw new Error(`No agent is logged in as "${cmd.target}".`);
  if (target.username === agent.username) throw new Error("You can't ask yourself.");
  const timeout = Math.max(1, Math.min(cmd.timeout_seconds ?? 60, 300));
  const ask_id = randomUUID();
  const questionMsg = ctx.state.addMessage(
    {
      from: agent.username,
      from_project: agent.project,
      scope: "dm",
      target: target.username,
      target_project: target.project,
      text: cmd.question,
      ask_id,
    },
    ctx.onMessageCreated,
  );
  const answer = await ctx.state.createAsk(
    ask_id,
    agent.username,
    target.username,
    questionMsg.id,
    timeout,
  );
  const statusHint = staleStatusHint(agent);
  const hintField = statusHint ? { hints: [statusHint] } : {};
  if (!answer) {
    return {
      status: "timeout",
      ask_id,
      note: `Target did not answer within ${timeout}s. They may still respond later as a regular DM.`,
      ...hintField,
    };
  }
  return {
    status: "answered",
    text: answer.text,
    from: answer.from,
    ask_id,
    ...hintField,
  };
}

function answer(
  ctx: HandlerContext,
  cmd: Extract<Command, { type: "answer" }>,
): unknown {
  if (!ctx.session.agent_id) throw new Error("Not logged in.");
  const agent = ctx.state.getAgent(ctx.session.agent_id);
  if (!agent) throw new Error("Session agent not found.");
  ctx.state.touchAgent(agent.id);
  const pending = ctx.state.getAsk(cmd.correlation_id);
  if (!pending) {
    throw new Error(
      "No pending ask with that correlation_id — it may have timed out or been cancelled.",
    );
  }
  if (pending.target_username !== agent.username) {
    throw new Error("This ask is directed at a different agent.");
  }
  if (!cmd.text || !cmd.text.trim()) throw new Error("Answer text is empty.");
  const asker = ctx.state.getAgentByUsername(pending.from_username);
  ctx.state.addMessage(
    {
      from: agent.username,
      from_project: agent.project,
      scope: "dm",
      target: pending.from_username,
      target_project: asker?.project,
      text: cmd.text,
      in_reply_to_ask: cmd.correlation_id,
    },
    ctx.onMessageCreated,
  );
  return { ok: true };
}
