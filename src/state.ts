import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readSummonUsernames } from "./summon-registry.js";
import type {
  Agent,
  Message,
  Mode,
  PublicAgent,
  Scope,
  SystemKind,
} from "./types.js";

export interface PendingAsk {
  ask_id: string;
  question_message_id: string;
  from_username: string;
  target_username: string;
  resolver: (answer: { text: string; from: string } | null) => void;
  timeout_handle: NodeJS.Timeout;
}

export type Listener = (msg: Message) => void;

const MENTION_RE = /@([a-zA-Z0-9_.\-]+)/g;

export function parseMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) out.add(m[1]);
  return Array.from(out);
}

/** Single-letter tag matching the first letter of the mode name, in upper
 * case. "all" has no tag. Used in list output and the keepalive roster. */
export function modeTag(mode: Mode): string {
  switch (mode) {
    case "all":
      return "";
    case "quiet":
      return "[Q]";
    case "project":
      return "[P]";
    case "dm":
      return "[D]";
  }
}

export function tooSimilar(a: string, b: string): boolean {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return true;
  const n = Math.min(4, al.length, bl.length);
  if (n < 3) return false;
  return al.slice(0, n) === bl.slice(0, n);
}

export class State {
  private agents = new Map<string, Agent>();
  private usernames = new Map<string, string>();
  private messages: Message[] = [];
  private cursors = new Map<string, number>();
  private emitter = new EventEmitter();
  private pendingAsks = new Map<string, PendingAsk>();
  private seqCounter = 0;

  private readonly maxMessages = 2000;

  constructor() {
    this.emitter.setMaxListeners(1000);
  }

  // --- Agent lifecycle ---

  createAgent(
    username: string,
    project: string,
    status: string,
    supports_channels = false,
  ): Agent {
    if (!username || /\s/.test(username)) {
      throw new Error("Username must be non-empty and contain no whitespace.");
    }
    if (/^(admin|system)$/i.test(username)) {
      throw new Error(
        `Username "${username}" is reserved (system/admin). Pick something else.`,
      );
    }
    const lower = username.toLowerCase();
    const takenDisplay = Array.from(this.agents.values()).map((a) => a.username);
    const takenList = takenDisplay.length
      ? ` Currently taken: ${takenDisplay.join(", ")}.`
      : "";
    if (this.usernames.has(lower)) {
      throw new Error(
        `Username "${username}" is already in use. Pick something distinctly different — try a different starting letter or a totally different name.${takenList}`,
      );
    }
    for (const takenLower of this.usernames.keys()) {
      if (tooSimilar(lower, takenLower)) {
        const existing =
          this.agents.get(this.usernames.get(takenLower)!)?.username ?? takenLower;
        throw new Error(
          `Username "${username}" is too similar to "${existing}". ` +
            `Pick something distinctly different — different starting letters, different vibe. ` +
            `Don't all converge on the same name patterns.${takenList}`,
        );
      }
    }
    const summonReserved = readSummonUsernames();
    const ownReservation = Array.from(summonReserved).some(
      (n) => n.toLowerCase() === lower,
    );
    if (!ownReservation) {
      for (const reserved of summonReserved) {
        if (tooSimilar(lower, reserved.toLowerCase())) {
          throw new Error(
            `Username "${username}" is too similar to summon-registered agent "${reserved}" on this machine. ` +
              `That name belongs to a persistent identity. Pick something distinctly different — different starting letters, different vibe.${takenList}`,
          );
        }
      }
    }
    const now = Date.now();
    const agent: Agent = {
      id: randomUUID(),
      username,
      project: project || "misc",
      status: status ?? "",
      connected_at: now,
      last_seen: now,
      status_updated_at: now,
      supports_channels,
      mode: "all",
      last_delivery_at: now,
    };
    this.agents.set(agent.id, agent);
    this.usernames.set(lower, agent.id);
    this.cursors.set(agent.id, this.seqCounter);
    return agent;
  }

  removeAgent(id: string): Agent | null {
    const agent = this.agents.get(id);
    if (!agent) return null;
    this.agents.delete(id);
    this.usernames.delete(agent.username.toLowerCase());
    this.cursors.delete(id);
    this.emitter.removeAllListeners(`message:${id}`);
    for (const [ask_id, ask] of this.pendingAsks) {
      if (
        ask.from_username === agent.username ||
        ask.target_username === agent.username
      ) {
        clearTimeout(ask.timeout_handle);
        this.pendingAsks.delete(ask_id);
        ask.resolver(null);
      }
    }
    return agent;
  }

  updateAgent(
    id: string,
    updates: { status?: string; username?: string; project?: string },
  ): Agent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error("Not logged in.");
    if (updates.username && updates.username !== agent.username) {
      if (/\s/.test(updates.username)) {
        throw new Error("Username must contain no whitespace.");
      }
      const newLower = updates.username.toLowerCase();
      if (
        this.usernames.has(newLower) &&
        this.usernames.get(newLower) !== id
      ) {
        throw new Error(`Username "${updates.username}" is in use.`);
      }
      const summonReserved = readSummonUsernames();
      const ownReservation = Array.from(summonReserved).some(
        (n) => n.toLowerCase() === newLower,
      );
      if (!ownReservation) {
        for (const reserved of summonReserved) {
          if (tooSimilar(newLower, reserved.toLowerCase())) {
            throw new Error(
              `Username "${updates.username}" is too similar to summon-registered agent "${reserved}" on this machine. Pick something distinctly different.`,
            );
          }
        }
      }
      this.usernames.delete(agent.username.toLowerCase());
      agent.username = updates.username;
      this.usernames.set(newLower, id);
    }
    if (updates.project !== undefined) agent.project = updates.project || "misc";
    if (updates.status !== undefined && updates.status !== agent.status) {
      agent.status = updates.status;
      agent.status_updated_at = Date.now();
    }
    agent.last_seen = Date.now();
    return agent;
  }

  touchAgent(id: string): void {
    const agent = this.agents.get(id);
    if (agent) agent.last_seen = Date.now();
  }

  setMode(id: string, mode: Mode): Agent | null {
    const agent = this.agents.get(id);
    if (!agent) return null;
    agent.mode = mode;
    return agent;
  }

  getAgent(id: string): Agent | null {
    return this.agents.get(id) ?? null;
  }

  getAgentByUsername(username: string): Agent | null {
    const id = this.usernames.get(username.toLowerCase());
    return id ? (this.agents.get(id) ?? null) : null;
  }

  listAgents(project?: string): PublicAgent[] {
    const out: PublicAgent[] = [];
    for (const a of this.agents.values()) {
      if (project && a.project !== project) continue;
      out.push({
        username: a.username,
        project: a.project,
        status: a.status,
        connected_at: a.connected_at,
        last_seen: a.last_seen,
        status_updated_at: a.status_updated_at,
        mode: a.mode,
      });
    }
    return out.sort((a, b) => a.username.localeCompare(b.username));
  }

  // --- Messages ---

  addMessage(
    input: {
      from: string;
      from_project?: string;
      scope: Scope;
      target?: string;
      target_project?: string;
      text: string;
      reply_to?: string;
      system?: boolean;
      system_kind?: SystemKind;
      system_actor?: string;
      ask_id?: string;
      in_reply_to_ask?: string;
      /** Agent id to suppress from both event stream and fetch cursor. */
      not_for?: string;
    },
    /**
     * Fires synchronously AFTER the message is pushed but BEFORE listeners
     * are notified. Lets the caller record the message id so they can filter
     * it out of a subscription they own (e.g. a monitor socket suppressing
     * its own broadcasts).
     */
    onCreated?: (msg: Message) => void,
  ): Message {
    const msg: Message = {
      id: randomUUID(),
      seq: ++this.seqCounter,
      ts: Date.now(),
      from: input.from,
      from_project: input.from_project,
      scope: input.scope,
      target: input.target,
      target_project: input.target_project,
      text: input.text,
      reply_to: input.reply_to,
      mentions: parseMentions(input.text),
      system: input.system,
      system_kind: input.system_kind,
      system_actor: input.system_actor,
      ask_id: input.ask_id,
      in_reply_to_ask: input.in_reply_to_ask,
    };
    this.messages.push(msg);
    if (this.messages.length > this.maxMessages) {
      this.messages.splice(0, this.messages.length - this.maxMessages);
    }

    onCreated?.(msg);

    // Figure out which agents should NOT receive this message on their
    // per-agent stream or via fetch/check_messages. The ask-reply case:
    // when `in_reply_to_ask` matches a pending ask, the asker will get
    // the text via the ask() tool's return value, so don't also deliver
    // it through the watcher — that causes duplicates.
    const suppressed = new Set<string>();
    if (input.not_for) suppressed.add(input.not_for);
    if (msg.in_reply_to_ask) {
      const pending = this.pendingAsks.get(msg.in_reply_to_ask);
      if (pending) {
        const askerAgent = this.getAgentByUsername(pending.from_username);
        if (askerAgent) suppressed.add(askerAgent.id);
      }
    }
    for (const agentId of suppressed) {
      this.advanceCursor(agentId, msg.seq);
    }

    for (const agent of this.agents.values()) {
      if (suppressed.has(agent.id)) continue;
      if (!this.isVisible(agent, msg)) continue;
      if (!this.isDeliverable(agent, msg)) continue;
      // Cursor advancement for delivered messages happens in takeMessages
      // (pull path) or daemon.ts (channel push path). For mode-filtered
      // messages, takeMessages walks past them and advances the cursor even
      // though they're not returned — ensuring a later mode flip doesn't
      // replay stale chatter.
      agent.last_delivery_at = Date.now();
      this.emitter.emit(`message:${agent.id}`, msg);
    }
    this.emitter.emit("message:*", msg);

    if (msg.in_reply_to_ask) {
      const ask = this.pendingAsks.get(msg.in_reply_to_ask);
      if (ask && msg.from === ask.target_username) {
        clearTimeout(ask.timeout_handle);
        this.pendingAsks.delete(msg.in_reply_to_ask);
        ask.resolver({ text: msg.text, from: msg.from });
      }
    }
    return msg;
  }

  isVisible(agent: Agent, msg: Message): boolean {
    if (msg.from === agent.username) return false;
    switch (msg.scope) {
      case "global":
        return true;
      case "project":
        return agent.project === msg.target;
      case "dm":
        return agent.username === msg.target;
    }
  }

  /** Delivery filter. `isVisible` must already be true. Admin broadcasts,
   * keepalives, DMs to me, and @mentions of me always pass regardless of
   * mode. Mode only matters for broad chatter and system events. */
  isDeliverable(agent: Agent, msg: Message): boolean {
    if (msg.system_kind === "keepalive") return true;
    if (msg.from === "admin") return true;
    const personal =
      msg.scope === "dm" ||
      this.mentionsUser(agent.username, msg.mentions);
    if (personal) return true;
    switch (agent.mode) {
      case "all":
        return true;
      case "quiet":
        return !msg.system;
      case "project":
        if (msg.system) {
          // Legacy system messages without from_project still deliver so we
          // don't lose data across a version upgrade.
          return !msg.from_project || msg.from_project === agent.project;
        }
        return msg.scope === "project";
      case "dm":
        return false;
    }
  }

  private mentionsUser(username: string, mentions: string[]): boolean {
    const me = username.toLowerCase();
    for (const m of mentions) {
      if (m.toLowerCase() === me) return true;
    }
    return false;
  }

  takeMessages(
    agent_id: string,
    limit = 50,
  ): { messages: Message[]; more: boolean } {
    const agent = this.agents.get(agent_id);
    if (!agent) return { messages: [], more: false };
    const cursor = this.cursors.get(agent_id) ?? 0;
    const out: Message[] = [];
    let lastVisibleSeq = cursor;
    let more = false;
    for (const m of this.messages) {
      if (m.seq <= cursor) continue;
      if (!this.isVisible(agent, m)) continue;
      // Advance cursor past every visible seq — even filtered ones — so a
      // later mode flip doesn't replay stale chatter.
      lastVisibleSeq = m.seq;
      if (!this.isDeliverable(agent, m)) continue;
      if (out.length >= limit) {
        more = true;
        break;
      }
      out.push(m);
    }
    if (lastVisibleSeq > cursor) this.cursors.set(agent_id, lastVisibleSeq);
    if (out.length > 0) agent.last_delivery_at = Date.now();
    return { messages: out, more };
  }

  onMessage(agent_id: string, listener: Listener): () => void {
    const handler = (m: Message) => listener(m);
    this.emitter.on(`message:${agent_id}`, handler);
    return () => this.emitter.off(`message:${agent_id}`, handler);
  }

  advanceCursor(agent_id: string, seq: number): void {
    const current = this.cursors.get(agent_id) ?? 0;
    if (seq > current) this.cursors.set(agent_id, seq);
  }

  onAllMessages(listener: Listener): () => void {
    const handler = (m: Message) => listener(m);
    this.emitter.on("message:*", handler);
    return () => this.emitter.off("message:*", handler);
  }

  recentMessages(limit: number): Message[] {
    if (limit <= 0) return [];
    return this.messages.slice(-limit);
  }

  // --- Asks ---

  createAsk(
    ask_id: string,
    from_username: string,
    target_username: string,
    question_message_id: string,
    timeout_seconds: number,
  ): Promise<{ text: string; from: string } | null> {
    return new Promise((resolve) => {
      const timeout_handle = setTimeout(() => {
        this.pendingAsks.delete(ask_id);
        resolve(null);
      }, timeout_seconds * 1000);
      this.pendingAsks.set(ask_id, {
        ask_id,
        question_message_id,
        from_username,
        target_username,
        resolver: resolve,
        timeout_handle,
      });
    });
  }

  getAsk(ask_id: string): PendingAsk | null {
    return this.pendingAsks.get(ask_id) ?? null;
  }

  // --- Keepalive ---

  /** Emit a synthetic `keepalive` DM to each non-channels agent that hasn't
   * received a message in >= `idle_ms`. Body is a one-shot roster snapshot so
   * stale agents refresh who's around and what they're doing when the ping
   * arrives. Channels-enabled agents are skipped — they're woken naturally. */
  sweepKeepalives(
    idle_ms: number,
    onCreated?: (msg: Message) => void,
  ): number {
    if (idle_ms <= 0) return 0;
    const now = Date.now();
    const targets: Agent[] = [];
    for (const a of this.agents.values()) {
      if (a.supports_channels) continue;
      if (now - a.last_delivery_at < idle_ms) continue;
      targets.push(a);
    }
    if (targets.length === 0) return 0;
    const body = this.renderRoster();
    for (const agent of targets) {
      this.addMessage(
        {
          from: "system",
          from_project: agent.project,
          scope: "dm",
          target: agent.username,
          target_project: agent.project,
          text: body,
          system: true,
          system_kind: "keepalive",
        },
        onCreated,
      );
    }
    return targets.length;
  }

  /** Human-readable roster snapshot used as the keepalive message body. */
  renderRoster(): string {
    const agents = Array.from(this.agents.values()).sort((a, b) =>
      a.username.localeCompare(b.username),
    );
    const byProject = new Map<string, Agent[]>();
    for (const a of agents) {
      const list = byProject.get(a.project);
      if (list) list.push(a);
      else byProject.set(a.project, [a]);
    }
    const lines: string[] = [
      `keepalive — ${agents.length} connected (watcher alive)`,
    ];
    for (const project of Array.from(byProject.keys()).sort()) {
      lines.push(`  [${project}]`);
      for (const a of byProject.get(project)!) {
        const tag = modeTag(a.mode);
        const marker = tag ? ` ${tag}` : "";
        const status = a.status ? ` — ${a.status}` : "";
        lines.push(`    ${a.username}${marker}${status}`);
      }
    }
    return lines.join("\n");
  }

  // --- Sweeper ---

  sweepStale(ttl_ms: number, onRemoved: (agent: Agent) => void): void {
    const now = Date.now();
    const stale: string[] = [];
    for (const [id, a] of this.agents) {
      if (now - a.last_seen > ttl_ms) stale.push(id);
    }
    for (const id of stale) {
      const agent = this.removeAgent(id);
      if (agent) onRemoved(agent);
    }
  }
}
