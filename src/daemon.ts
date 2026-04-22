import net from "node:net";
import fs from "node:fs";
import { createRequire } from "node:module";
import { ensureStateDir, PID_PATH, SOCKET_PATH } from "./paths.js";
import { State } from "./state.js";
import { handle, type Session } from "./handlers.js";
import type { ClientRequest, ServerMessage } from "./protocol.js";
import { openTranscript } from "./transcript.js";

const pkgVersion: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    return (require("../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const STALE_TTL_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;
const IDLE_EXIT_MS = 10 * 60 * 1000;
const DEFAULT_KEEPALIVE_MINUTES = 30;

function resolveKeepaliveMs(): number {
  const raw = process.env.CHAT_MCP_KEEPALIVE_MINUTES;
  if (raw === undefined) return DEFAULT_KEEPALIVE_MINUTES * 60_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_KEEPALIVE_MINUTES * 60_000;
  return Math.floor(n * 60_000);
}

export async function runDaemon(): Promise<void> {
  ensureStateDir();

  if (fs.existsSync(SOCKET_PATH)) {
    if (await isSocketAlive(SOCKET_PATH)) {
      console.error("[daemon] another daemon is already running; exiting.");
      return;
    }
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // ignore
    }
  }

  const state = new State();
  const clients = new Set<net.Socket>();
  let lastClientSeen = Date.now();

  const transcript = openTranscript({ pid: process.pid, version: pkgVersion });
  const stopTranscript = state.onAllMessages((m) => transcript.recordMessage(m));
  if (transcript.path) {
    console.error(`[daemon] transcript: ${transcript.path}`);
  } else if (process.env.CHAT_MCP_DISABLE_TRANSCRIPTS) {
    console.error("[daemon] transcripts disabled via CHAT_MCP_DISABLE_TRANSCRIPTS");
  }

  const server = net.createServer((socket) => {
    clients.add(socket);
    lastClientSeen = Date.now();
    const session: Session = { agent_id: null };
    let unsubscribe: (() => void) | null = null;
    let buffer = "";

    // Track messages this socket originated so we can skip emitting them
    // back on our own subscription. Populated via HandlerContext.onMessageCreated
    // (fires synchronously inside addMessage, before any event is emitted).
    const ownSentIds = new Set<string>();
    const trackOwn = (m: { id: string }): void => {
      ownSentIds.add(m.id);
      if (ownSentIds.size > 512) {
        const first = ownSentIds.values().next().value;
        if (first) ownSentIds.delete(first);
      }
    };

    const send = (msg: ServerMessage) => {
      if (socket.destroyed) return;
      try {
        socket.write(JSON.stringify(msg) + "\n");
      } catch {
        // ignore
      }
    };

    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let req: ClientRequest;
        try {
          req = JSON.parse(line);
        } catch {
          send({
            kind: "result",
            id: -1,
            ok: false,
            error: "Invalid JSON line.",
          });
          continue;
        }
        try {
          const data = await handle(
            { state, session, onMessageCreated: trackOwn },
            req.cmd,
          );
          send({ kind: "result", id: req.id, ok: true, data });
          if (req.cmd.type === "login" && session.agent_id) {
            const agent_id = session.agent_id;
            const agent = state.getAgent(agent_id);
            const advance = agent?.supports_channels ?? false;
            unsubscribe = state.onMessage(agent_id, (m) => {
              if (ownSentIds.has(m.id)) return;
              send({ kind: "event", event: "message", data: m });
              if (advance) state.advanceCursor(agent_id, m.seq);
            });
          }
          if (req.cmd.type === "monitor") {
            if (unsubscribe) unsubscribe();
            unsubscribe = state.onAllMessages((m) => {
              if (ownSentIds.has(m.id)) return;
              send({ kind: "event", event: "message", data: m });
            });
          }
          if (req.cmd.type === "logout" && unsubscribe) {
            unsubscribe();
            unsubscribe = null;
          }
        } catch (err) {
          send({
            kind: "result",
            id: req.id,
            ok: false,
            error: (err as Error).message,
          });
        }
      }
    });

    const cleanup = () => {
      clients.delete(socket);
      lastClientSeen = Date.now();
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (session.agent_id) {
        const agent = state.removeAgent(session.agent_id);
        session.agent_id = null;
        if (agent) {
          state.addMessage(
            {
              from: "system",
              from_project: agent.project,
              scope: "global",
              text: `${agent.username} left (disconnected)`,
              system: true,
              system_kind: "leave",
              system_actor: agent.username,
            },
            trackOwn,
          );
        }
      }
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error) => reject(err);
    server.once("error", onErr);
    server.listen(SOCKET_PATH, () => {
      server.off("error", onErr);
      try {
        fs.chmodSync(SOCKET_PATH, 0o600);
      } catch {
        // ignore
      }
      try {
        fs.writeFileSync(PID_PATH, String(process.pid));
      } catch {
        // ignore
      }
      resolve();
    });
  });

  console.error(`[daemon] listening on ${SOCKET_PATH} (pid ${process.pid})`);

  let shuttingDown = false;
  const cleanShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(sweeper);
    stopTranscript();
    transcript.close("shutdown");
    // Unlink socket/pid FIRST so any concurrent ensureDaemon sees a clean
    // slate and can safely spawn the next daemon immediately.
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(PID_PATH);
    } catch {
      // ignore
    }
    for (const c of clients) c.destroy();
    server.close();
    // Don't wait on server.close() callback — it can hang on half-closed
    // connections. Hard-exit after a short grace period so we never leave
    // a zombie daemon alongside a newly-spawned one.
    setTimeout(() => process.exit(0), 100).unref();
  };

  const keepaliveMs = resolveKeepaliveMs();
  const sweeper = setInterval(() => {
    state.sweepStale(STALE_TTL_MS, (agent) => {
      state.addMessage({
        from: "system",
        from_project: agent.project,
        scope: "global",
        text: `${agent.username} timed out (idle > 5m)`,
        system: true,
        system_kind: "leave",
        system_actor: agent.username,
      });
    });
    if (keepaliveMs > 0) {
      state.sweepKeepalives(keepaliveMs);
    }
    if (clients.size === 0 && Date.now() - lastClientSeen > IDLE_EXIT_MS) {
      console.error("[daemon] no clients for >10m; shutting down.");
      cleanShutdown();
    }
  }, SWEEP_INTERVAL_MS);

  process.on("SIGTERM", cleanShutdown);
  process.on("SIGINT", cleanShutdown);
}

async function isSocketAlive(path: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const s = net.connect(path);
    const done = (result: boolean) => {
      s.destroy();
      resolve(result);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}
