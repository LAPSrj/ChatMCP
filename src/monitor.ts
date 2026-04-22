import { DaemonClient } from "./daemon-client.js";
import { ensureDaemon } from "./spawn-daemon.js";
import { createFormatter, paintWith } from "./format.js";
import type { Message } from "./types.js";

interface Options {
  tail: number;
  color: boolean;
}

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
      process.stdout.write(
        "chat-mcp monitor — tail all messages in the chat room\n\n" +
          "Options:\n" +
          "  --tail N        Print last N messages on start (default 20, max 500)\n" +
          "  --no-tail       Only show new messages (equivalent to --tail 0)\n" +
          "  --color         Force ANSI colors\n" +
          "  --no-color      Disable ANSI colors\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { tail, color };
}

export async function runMonitor(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  await ensureDaemon();
  const client = await DaemonClient.connect();

  const paint = paintWith(opts.color);
  const { format } = createFormatter(opts.color);

  const separator = (): string => {
    const cols = process.stdout.columns;
    const width = typeof cols === "number" && cols > 0 ? cols : 80;
    return paint("grey", "─".repeat(width));
  };

  client.onMessage((m) => {
    process.stdout.write(format(m) + "\n" + separator() + "\n");
  });

  const roster = (await client.cmd({ type: "list_agents" })) as {
    agents: Array<{
      username: string;
      project: string;
      status: string;
      mode?: "all" | "quiet" | "project" | "dm";
    }>;
  };
  const modeLetter = (m: string | undefined): string => {
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
  if (roster.agents.length === 0) {
    process.stdout.write(paint("grey", "(no agents connected)\n"));
  } else {
    process.stdout.write(
      paint("grey", `${roster.agents.length} agent(s) connected:\n`),
    );
    for (const a of roster.agents) {
      const tag = modeLetter(a.mode);
      const modeTag = tag ? " " + paint("yellow", tag) : "";
      process.stdout.write(
        `  ${paint("bold", a.username)} ${paint("dim", `(${a.project})`)}${modeTag}${a.status ? ` — ${a.status}` : ""}\n`,
      );
    }
  }

  const result = (await client.cmd({ type: "monitor", tail: opts.tail })) as {
    history: Message[];
  };
  for (const m of result.history) {
    process.stdout.write(format(m) + "\n" + separator() + "\n");
  }
  process.stderr.write(paint("grey", "(monitoring — Ctrl-C to stop)\n"));

  client.onClose(() => {
    process.stderr.write(paint("grey", "daemon closed\n"));
    process.exit(0);
  });

  process.on("SIGINT", () => {
    process.stderr.write("\n");
    process.exit(0);
  });

  await new Promise<void>(() => {});
}
