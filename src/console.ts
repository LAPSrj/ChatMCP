import readline from "node:readline";
import { DaemonClient } from "./daemon-client.js";
import { ensureDaemon } from "./spawn-daemon.js";
import { createFormatter, paintWith } from "./format.js";
import { stripAnsi } from "./markdown.js";
import type { Message } from "./types.js";

interface Options {
  tail: number;
  color: boolean;
}

const HELP = `chat-mcp console — interactive admin chat (watch + broadcast)

Options:
  --tail N       Print last N messages on start (default 20, max 500)
  --no-tail      Skip backfill, only show new messages
  --color        Force ANSI colors
  --no-color     Disable ANSI colors

Prompt commands (type at the [admin] > prompt):
  <text>                   Broadcast as admin to scope=global (default).
  /g <text>                Same as above.
  /dm <user> <text>        DM to <user> as admin.
  /proj <project> <text>   Broadcast to project <project>. Short: /p
  /who                     Print currently connected agents.
  /help                    Show this.
  /quit                    Exit (Ctrl-C also works).
`;

function parseArgs(argv: string[]): Options {
  let tail = 20;
  let color = process.stdout.isTTY ?? false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-color") color = false;
    else if (a === "--color") color = true;
    else if (a === "--tail") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error("--tail expects a non-negative integer");
      }
      tail = Math.min(n, 500);
    } else if (a === "--no-tail") tail = 0;
    else if (a === "-h" || a === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { tail, color };
}

export async function runConsole(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  await ensureDaemon();
  const client = await DaemonClient.connect();

  const paint = paintWith(opts.color);
  const { format } = createFormatter(opts.color);

  const prompt = paint("bold", paint("red", "[admin] > "));
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt,
    terminal: Boolean(process.stdin.isTTY),
  });

  const separator = (): string => {
    const cols = process.stdout.columns;
    const width = typeof cols === "number" && cols > 0 ? cols : 80;
    return paint("grey", "─".repeat(width));
  };

  // --- Pinned status area (roster) just above the prompt. ----------------
  // We keep the roster plus its separator as `statusLines` and redraw them
  // after every piece of output. On each print we move the cursor up by the
  // status area's rendered height, clear to end of screen, write the new
  // content, then redraw status + prompt.
  let statusLines: string[] = [];

  const statusHeight = (): number => {
    if (!rl.terminal) return 0;
    const cols = process.stdout.columns;
    const w = typeof cols === "number" && cols > 0 ? cols : 80;
    let rows = 0;
    for (const l of statusLines) {
      const visLen = stripAnsi(l).length;
      rows += Math.max(1, Math.ceil(visLen / w));
    }
    return rows;
  };

  const clearStatusArea = (): void => {
    if (!rl.terminal) return;
    // Cursor is currently on the prompt line (possibly mid-input). Walk it
    // back to column 0 of the first status line, then wipe everything down.
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    const h = statusHeight();
    if (h > 0) {
      readline.moveCursor(process.stdout, 0, -h);
      readline.clearScreenDown(process.stdout);
    }
  };

  const drawStatusArea = (): void => {
    if (statusLines.length > 0) {
      process.stdout.write(statusLines.join("\n") + "\n");
    }
    if (rl.terminal) rl.prompt(true);
  };

  const setStatusLines = (lines: string[]): void => {
    clearStatusArea();
    statusLines = lines;
    drawStatusArea();
  };

  const printLine = (line: string): void => {
    clearStatusArea();
    process.stdout.write(line + "\n");
    drawStatusArea();
  };

  const printMessage = (m: Message): void => {
    printLine(format(m) + "\n" + separator());
  };

  // Keepalives fan out to every non-channels agent in the same daemon sweep,
  // so they arrive in a burst (microseconds apart). Rendering each one
  // individually means the admin sees the full roster dump N times in a row.
  // Coalesce them: buffer targets for a short window, then emit one summary
  // line "HH:MM:SS · keepalive — pinged N: alice, bob, ...".
  const KEEPALIVE_COALESCE_MS = 500;
  let keepaliveBuf: { ts: number; targets: string[] } | null = null;
  let keepaliveTimer: NodeJS.Timeout | null = null;

  const flushKeepaliveBuf = (): void => {
    if (!keepaliveBuf) return;
    const { ts, targets } = keepaliveBuf;
    keepaliveBuf = null;
    if (keepaliveTimer) {
      clearTimeout(keepaliveTimer);
      keepaliveTimer = null;
    }
    const when = new Date(ts).toLocaleTimeString("en-GB");
    const time = paint("grey", when);
    // Each ANSI-styled segment is wrapped independently — nesting grey
    // around a bolded count would reset back to default white for the rest
    // of the line when the inner bold reset fires.
    const intro = paint("grey", "keepalive — pinged ");
    const count = paint("bold", paint("grey", String(targets.length)));
    const tail = paint("grey", `: ${targets.join(", ")}`);
    printLine(`${time} ${paint("grey", "·")} ${intro}${count}${tail}`);
  };

  const handleKeepalive = (m: Message): void => {
    const target = m.target ?? "?";
    if (!keepaliveBuf) keepaliveBuf = { ts: m.ts, targets: [] };
    if (!keepaliveBuf.targets.includes(target)) {
      keepaliveBuf.targets.push(target);
    }
    if (keepaliveTimer) clearTimeout(keepaliveTimer);
    keepaliveTimer = setTimeout(flushKeepaliveBuf, KEEPALIVE_COALESCE_MS);
  };

  // Future messages read process.stdout.columns fresh in format(), so they
  // naturally adopt the new width. On resize, also redraw the status area +
  // prompt so the pinned roster stays correctly positioned.
  process.stdout.on("resize", () => {
    if (rl.terminal) rl.prompt(true);
  });

  type RosterAgent = {
    username: string;
    project: string;
    status: string;
    mode?: "all" | "quiet" | "project" | "dm";
  };
  const modeLetter = (m: RosterAgent["mode"]): string => {
    switch (m) {
      case "quiet":
        return "[Q]";
      case "project":
        return "[P]";
      case "dm":
        return "[D]";
      default:
        return "";
    }
  };
  const renderRoster = (agents: RosterAgent[]): string => {
    if (agents.length === 0) return paint("grey", "(no agents connected)");
    const byProject = new Map<string, RosterAgent[]>();
    for (const a of agents) {
      const list = byProject.get(a.project);
      if (list) list.push(a);
      else byProject.set(a.project, [a]);
    }
    const projects = Array.from(byProject.keys()).sort();
    const lines: string[] = [
      paint("grey", `${agents.length} agent(s) connected:`),
    ];
    const sep = paint("grey", ", ");
    for (const proj of projects) {
      const users = byProject
        .get(proj)!
        .slice()
        .sort((a, b) => a.username.localeCompare(b.username))
        .map((a) => {
          const name = paint("bold", paint("cyan", a.username));
          const tag = modeLetter(a.mode);
          return tag ? `${name} ${paint("yellow", tag)}` : name;
        })
        .join(sep);
      lines.push(`  ${paint("grey", `[${proj}]`)} ${users}`);
    }
    return lines.join("\n");
  };

  const refreshRoster = async (): Promise<void> => {
    try {
      const res = (await client.cmd({ type: "list_agents" })) as {
        agents: RosterAgent[];
      };
      const rendered = renderRoster(res.agents);
      const lines = rendered.split("\n");
      lines.push(separator());
      setStatusLines(lines);
    } catch (err) {
      printLine(paint("red", `error: ${(err as Error).message}`));
    }
  };

  // Auto-refresh the roster on any system message except status updates
  // (statuses don't appear in the roster, so refreshing is wasted work).
  // Older daemons emit system messages without `system_kind`; treat those
  // as membership changes too so the roster stays live across version skew.
  client.onMessage((m) => {
    if (m.system_kind === "keepalive") {
      handleKeepalive(m);
      return;
    }
    printMessage(m);
    if (m.system && m.system_kind !== "status") {
      void refreshRoster();
    }
  });

  const res = (await client.cmd({ type: "monitor", tail: opts.tail })) as {
    history: Message[];
  };
  // Collapse consecutive keepalives that share the same second — a single
  // daemon sweep fans out to N agents all within the same ts, so the tail
  // would otherwise render N copies of the same roster dump.
  let pendingKeepalive: { ts: number; targets: string[] } | null = null;
  const flushPending = (): void => {
    if (!pendingKeepalive) return;
    const { ts, targets } = pendingKeepalive;
    pendingKeepalive = null;
    const when = new Date(ts).toLocaleTimeString("en-GB");
    const time = paint("grey", when);
    const intro = paint("grey", "keepalive — pinged ");
    const count = paint("bold", paint("grey", String(targets.length)));
    const tail = paint("grey", `: ${targets.join(", ")}`);
    process.stdout.write(
      `${time} ${paint("grey", "·")} ${intro}${count}${tail}\n${separator()}\n`,
    );
  };
  for (const m of res.history) {
    if (m.system_kind === "keepalive") {
      const bucket = Math.floor(m.ts / 1000);
      if (pendingKeepalive && Math.floor(pendingKeepalive.ts / 1000) === bucket) {
        const t = m.target ?? "?";
        if (!pendingKeepalive.targets.includes(t))
          pendingKeepalive.targets.push(t);
      } else {
        flushPending();
        pendingKeepalive = { ts: m.ts, targets: [m.target ?? "?"] };
      }
      continue;
    }
    flushPending();
    process.stdout.write(format(m) + "\n" + separator() + "\n");
  }
  flushPending();

  await refreshRoster();

  const send = async (
    scope: "global" | "project" | "dm",
    target: string | undefined,
    text: string,
  ): Promise<void> => {
    try {
      await client.cmd({
        type: "admin_broadcast",
        scope,
        target,
        text,
      });
    } catch (err) {
      printLine(paint("red", `error: ${(err as Error).message}`));
    }
  };

  const parseSlash = (line: string): void => {
    if (line === "/help" || line === "/?") {
      printLine(HELP);
      return;
    }
    if (line === "/quit" || line === "/exit") {
      rl.close();
      return;
    }
    if (line === "/who") {
      void refreshRoster();
      return;
    }
    if (line.startsWith("/dm ")) {
      const rest = line.slice(4).trim();
      const i = rest.indexOf(" ");
      if (i < 0) return printLine(paint("red", "usage: /dm <user> <text>"));
      const user = rest.slice(0, i);
      const text = rest.slice(i + 1).trim();
      if (!text) return printLine(paint("red", "empty text"));
      void send("dm", user, text);
      return;
    }
    if (line.startsWith("/proj ") || line.startsWith("/p ")) {
      const rest = line.startsWith("/proj ")
        ? line.slice(6).trim()
        : line.slice(3).trim();
      const i = rest.indexOf(" ");
      if (i < 0)
        return printLine(paint("red", "usage: /proj <project> <text>"));
      const proj = rest.slice(0, i);
      const text = rest.slice(i + 1).trim();
      if (!text) return printLine(paint("red", "empty text"));
      void send("project", proj, text);
      return;
    }
    if (line.startsWith("/g ") || line.startsWith("/global ")) {
      const text = line.startsWith("/g ")
        ? line.slice(3).trim()
        : line.slice(8).trim();
      if (!text) return printLine(paint("red", "empty text"));
      void send("global", undefined, text);
      return;
    }
    printLine(
      paint("red", `unknown command: ${line.split(" ")[0]} (try /help)`),
    );
  };

  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      return;
    }
    if (line.startsWith("/")) parseSlash(line);
    else void send("global", undefined, line);
    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });

  client.onClose(() => {
    process.stderr.write(paint("grey", "\ndaemon closed\n"));
    process.exit(0);
  });

  rl.prompt();
  await new Promise<void>(() => {});
}
