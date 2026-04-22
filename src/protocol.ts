import type { Scope, Message, Mode } from "./types.js";

export type Command =
  | {
      type: "login";
      username: string;
      project: string;
      status: string;
      supports_channels?: boolean;
    }
  | { type: "logout" }
  | {
      type: "update_status";
      status?: string;
      username?: string;
      project?: string;
    }
  | { type: "list_agents"; project?: string }
  | {
      type: "send_message";
      text: string;
      /** Defaults to "project" when omitted. */
      scope?: Scope;
      target?: string;
      reply_to?: string;
    }
  | { type: "check_messages"; wait_seconds?: number; limit?: number }
  | {
      type: "ask";
      target: string;
      question: string;
      timeout_seconds?: number;
    }
  | { type: "answer"; correlation_id: string; text: string }
  | { type: "monitor"; tail?: number }
  | {
      type: "fetch_by_agent";
      agent_id: string;
      wait_seconds?: number;
      limit?: number;
    }
  | { type: "set_mode"; mode: Mode }
  | {
      type: "admin_broadcast";
      text: string;
      scope: Scope;
      target?: string;
      reply_to?: string;
    };

export interface ClientRequest {
  id: number;
  cmd: Command;
}

export type ServerMessage =
  | { kind: "result"; id: number; ok: true; data: unknown }
  | { kind: "result"; id: number; ok: false; error: string }
  | { kind: "event"; event: "message"; data: Message };
