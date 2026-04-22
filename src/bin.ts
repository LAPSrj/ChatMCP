#!/usr/bin/env node
import { runDaemon } from "./daemon.js";
import { runMcpServer } from "./mcp-server.js";
import { runMonitor } from "./monitor.js";
import { runFetch } from "./fetch.js";
import { runConsole } from "./console.js";

const mode = process.argv[2] ?? null;
const rest = process.argv.slice(3);

if (mode === "--daemon" || mode === "daemon") {
  runDaemon().catch((err) => {
    console.error("[daemon] fatal:", err);
    process.exit(1);
  });
} else if (mode === "monitor" || mode === "--monitor") {
  runMonitor(rest).catch((err) => {
    console.error("[monitor]", (err as Error).message);
    process.exit(1);
  });
} else if (mode === "console" || mode === "--console") {
  runConsole(rest).catch((err) => {
    console.error("[console]", (err as Error).message);
    process.exit(1);
  });
} else if (mode === "fetch" || mode === "--fetch") {
  runFetch(rest).catch((err) => {
    console.error("[fetch]", (err as Error).message);
    process.exit(1);
  });
} else if (mode === null || mode === "--serve" || mode === "serve") {
  runMcpServer().catch((err) => {
    console.error("[mcp] fatal:", err);
    process.exit(1);
  });
} else if (mode === "--help" || mode === "-h") {
  process.stdout.write(
    "chat-mcp — multi-agent chat MCP server\n\n" +
      "Usage:\n" +
      "  chat-mcp             Run as stdio MCP server (launched by Claude Code)\n" +
      "  chat-mcp --daemon    Run the background state daemon (auto-spawned)\n" +
      "  chat-mcp monitor     Tail all messages in the chat (read-only)\n" +
      "                       Flags: --tail N, --no-tail, --color, --no-color\n" +
      "  chat-mcp console     Interactive admin chat — watch + broadcast as 'admin'\n" +
      "                       Same flags as monitor; type /help at the prompt.\n" +
      "  chat-mcp fetch       Drain pending messages for this session's agent\n" +
      "                       (intended to be spawned as a bg task by agents).\n" +
      "                       Flags: --agent-id ID, --wait N, --loop, --json,\n" +
      "                              --text, --rewake. See 'chat-mcp fetch --help'.\n",
  );
} else {
  console.error(`Unknown mode: ${mode}. Try --help.`);
  process.exit(1);
}
