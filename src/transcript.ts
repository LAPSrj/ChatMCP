import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "./types.js";

export const TRANSCRIPT_DIR = path.join(os.homedir(), ".chat-mcp", "transcripts");

function transcriptsDisabled(): boolean {
  const v = process.env.CHAT_MCP_DISABLE_TRANSCRIPTS;
  if (!v) return false;
  const lower = v.toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes";
}

function filenameTimestamp(d: Date): string {
  // ISO-ish, safe for Windows filenames (no colons).
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}Z`
  );
}

export interface TranscriptWriter {
  recordMessage(msg: Message): void;
  close(reason?: string): void;
  readonly path: string | null;
}

export function openTranscript(meta: {
  pid: number;
  version: string;
}): TranscriptWriter {
  if (transcriptsDisabled()) {
    return {
      path: null,
      recordMessage() {},
      close() {},
    };
  }

  let filePath: string;
  let stream: fs.WriteStream;
  try {
    fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
    const startedAt = new Date();
    filePath = path.join(
      TRANSCRIPT_DIR,
      `session-${filenameTimestamp(startedAt)}-${meta.pid}.jsonl`,
    );
    stream = fs.createWriteStream(filePath, { flags: "a", mode: 0o600 });
    stream.on("error", () => {
      // Swallow writer errors — transcripts must never take the daemon down.
    });
    writeLine(stream, {
      type: "session_start",
      ts: startedAt.getTime(),
      pid: meta.pid,
      version: meta.version,
      platform: process.platform,
      node: process.version,
    });
  } catch {
    return {
      path: null,
      recordMessage() {},
      close() {},
    };
  }

  let closed = false;
  return {
    get path() {
      return filePath;
    },
    recordMessage(msg) {
      if (closed) return;
      writeLine(stream, { type: "message", ...msg });
    },
    close(reason) {
      if (closed) return;
      closed = true;
      writeLine(stream, {
        type: "session_end",
        ts: Date.now(),
        reason: reason ?? "shutdown",
      });
      stream.end();
    },
  };
}

function writeLine(stream: fs.WriteStream, obj: unknown): void {
  try {
    stream.write(JSON.stringify(obj) + "\n");
  } catch {
    // ignore
  }
}
