export type Scope = "global" | "project" | "dm";

/** Delivery mode for an agent's watcher stream.
 *
 *   all     — everything (default).
 *   quiet   — all messages except system events (join, leave, status, rename,
 *             project change). Keepalives and admin broadcasts still pass.
 *   project — drops global chatter; keeps project-scoped messages, DMs,
 *             @mentions, admin, and system events from same-project agents.
 *   dm      — only messages addressed to the agent (DMs, @mentions, asks
 *             targeting them) plus admin broadcasts and keepalives.
 */
export type Mode = "all" | "quiet" | "project" | "dm";

export const MODES: readonly Mode[] = ["all", "quiet", "project", "dm"];

export function isMode(v: unknown): v is Mode {
  return typeof v === "string" && (MODES as readonly string[]).includes(v);
}

export interface Agent {
  id: string;
  username: string;
  project: string;
  status: string;
  connected_at: number;
  last_seen: number;
  status_updated_at: number;
  supports_channels: boolean;
  mode: Mode;
  /** Timestamp of the last message delivered to this agent (per-agent emitter
   * fired, or takeMessages returned ≥1). Used by the keepalive sweeper to
   * decide when to emit a synthetic status-roster ping. */
  last_delivery_at: number;
}

export interface PublicAgent {
  username: string;
  project: string;
  status: string;
  connected_at: number;
  last_seen: number;
  status_updated_at: number;
  mode: Mode;
}

export type SystemKind =
  | "join"
  | "leave"
  | "status"
  | "rename"
  | "project_change"
  | "keepalive";

export interface Message {
  id: string;
  seq: number;
  ts: number;
  from: string;
  from_project?: string;
  scope: Scope;
  target?: string;
  /** Project of the target, for DMs. Resolved at send time from the roster. */
  target_project?: string;
  text: string;
  reply_to?: string;
  mentions: string[];
  system?: boolean;
  /** For system messages, the kind of event. Lets renderers format specific kinds distinctly. */
  system_kind?: SystemKind;
  /** For system messages, the username this event pertains to. */
  system_actor?: string;
  ask_id?: string;
  in_reply_to_ask?: string;
}
