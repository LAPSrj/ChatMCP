import net from "node:net";
import { SOCKET_PATH } from "./paths.js";
import type { ClientRequest, Command, ServerMessage } from "./protocol.js";
import type { Message } from "./types.js";

export class DaemonClient {
  private socket: net.Socket;
  private buffer = "";
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private messageListener: ((m: Message) => void) | null = null;
  private closeListeners: Array<() => void> = [];
  private closed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("close", () => this.handleClose());
    socket.on("error", () => this.handleClose());
  }

  static async connect(timeoutMs = 5000): Promise<DaemonClient> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: Error | null = null;
    while (Date.now() < deadline) {
      try {
        return await new Promise<DaemonClient>((resolve, reject) => {
          const socket = net.connect(SOCKET_PATH);
          const onErr = (err: Error) => {
            socket.destroy();
            reject(err);
          };
          socket.once("connect", () => {
            socket.off("error", onErr);
            resolve(new DaemonClient(socket));
          });
          socket.once("error", onErr);
        });
      } catch (err) {
        lastErr = err as Error;
        await sleep(100);
      }
    }
    throw new Error(
      `Failed to connect to chat-mcp daemon at ${SOCKET_PATH}: ${
        lastErr?.message ?? "timeout"
      }`,
    );
  }

  cmd(cmd: Command): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("Daemon connection closed."));
    }
    const id = ++this.seq;
    const req: ClientRequest = { id, cmd };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.write(JSON.stringify(req) + "\n");
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  onMessage(listener: (m: Message) => void): void {
    this.messageListener = listener;
  }

  onClose(listener: () => void): void {
    if (this.closed) {
      listener();
      return;
    }
    this.closeListeners.push(listener);
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.kind === "event") {
        if (msg.event === "message" && this.messageListener) {
          try {
            this.messageListener(msg.data);
          } catch {
            // ignore
          }
        }
      } else if (msg.kind === "result") {
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        this.pending.delete(msg.id);
        if (msg.ok) pending.resolve(msg.data);
        else pending.reject(new Error(msg.error));
      }
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      p.reject(new Error("Daemon connection closed."));
    }
    this.pending.clear();
    for (const l of this.closeListeners) {
      try {
        l();
      } catch {
        // ignore
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
