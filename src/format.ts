import type { Message } from "./types.js";
import { renderMarkdownBlock } from "./markdown.js";

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  grey: "\x1b[90m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
};

export type AnsiColor = keyof typeof ANSI;

// Message body is flush-left (no hanging indent).
const INDENT = "";
const MIN_BODY_WIDTH = 20;

export interface Formatter {
  format(m: Message): string;
}

export function createFormatter(color: boolean): Formatter {
  const paint = (c: AnsiColor, s: string): string =>
    color ? `${ANSI[c]}${s}${ANSI.reset}` : s;

  const termWidth = (): number => {
    const c = process.stdout.columns;
    return typeof c === "number" && c > 0 ? c : 80;
  };

  const wrap = (text: string, width: number): string[] => {
    const w = Math.max(MIN_BODY_WIDTH, width);
    const out: string[] = [];
    for (const segment of text.split("\n")) {
      if (segment.length <= w) {
        out.push(segment);
        continue;
      }
      let rest = segment;
      while (rest.length > w) {
        let brk = rest.lastIndexOf(" ", w);
        if (brk <= 0) brk = w;
        out.push(rest.slice(0, brk));
        rest = rest.slice(brk).trimStart();
      }
      if (rest.length) out.push(rest);
    }
    return out;
  };

  // Apply color per line so ANSI doesn't span newlines — some terminals
  // bleed background colors across wrapped lines otherwise.
  const renderBody = (
    text: string,
    bodyStyle?: AnsiColor | AnsiColor[],
  ): string => {
    const width = Math.max(MIN_BODY_WIDTH, termWidth() - INDENT.length);
    // Uniform-styled bodies (admin bold, status italic+grey) skip markdown —
    // the outer style is the whole point. For normal messages we render block
    // + inline markdown and wrap ANSI-aware so spans survive line breaks.
    if (bodyStyle) {
      const styles = Array.isArray(bodyStyle) ? bodyStyle : [bodyStyle];
      const lines = wrap(text, width);
      const stylize = (l: string): string =>
        styles.reduce<string>((acc, c) => paint(c, acc), l);
      return lines.map((l) => INDENT + stylize(l)).join("\n");
    }
    if (!color) {
      return wrap(text, width)
        .map((l) => INDENT + l)
        .join("\n");
    }
    const rendered = renderMarkdownBlock(text, width);
    return rendered
      .split("\n")
      .map((l) => INDENT + l)
      .join("\n");
  };

  // Destination rendered after the arrow. For DMs we only show the
  // recipient's project when it differs from the sender's — same-project DMs
  // keep the line quieter. Admin has no sender project, so the target's
  // project is always shown for admin DMs.
  const destLabel = (m: Message, senderProject?: string): string => {
    if (m.scope === "global") return paint("green", "Everyone");
    if (m.scope === "project") return paint("cyan", `#${m.target ?? "?"}`);
    const user = paint("magenta", m.target ?? "?");
    const showTargetProj =
      m.target_project && m.target_project !== senderProject;
    const proj = showTargetProj
      ? " " + paint("grey", `[${m.target_project}]`)
      : "";
    return `${user}${proj}`;
  };

  const format = (m: Message): string => {
    const when = new Date(m.ts).toLocaleTimeString("en-GB");
    const time = paint("grey", when);

    if (m.system) {
      if (m.system_kind === "status" && m.system_actor) {
        const actor = paint("bold", paint("cyan", m.system_actor));
        const header = `${time} ${actor} ${paint("grey", "status:")}`;
        return `${header}\n${renderBody(m.text, ["grey", "italic"])}`;
      }
      // Legacy single-line status messages from before system_kind existed
      // still look like "username status: foo" or "username ... ; status: ...".
      // Italicize them so they match the newer two-line status style.
      const isLegacyStatus = /\bstatus:\s/i.test(m.text);
      const body = isLegacyStatus
        ? paint("italic", paint("grey", m.text))
        : paint("grey", m.text);
      return `${time} ${paint("grey", "·")} ${body}`;
    }

    const arrow = paint("grey", "->");
    const ask = m.ask_id
      ? " " + paint("yellow", "[?]")
      : m.in_reply_to_ask
        ? " " + paint("yellow", "[↳]")
        : "";

    if (m.from === "admin") {
      const from = paint("bold", paint("red", "admin"));
      const header = `${time} ${from} ${arrow} ${destLabel(m)}${ask}`;
      return `${header}\n${renderBody(m.text, "bold")}`;
    }

    const fromProjTag = m.from_project
      ? paint("grey", `[${m.from_project}]`) + " "
      : "";
    const from = paint("bold", paint("cyan", m.from));
    const header = `${time} ${fromProjTag}${from} ${arrow} ${destLabel(m, m.from_project)}${ask}`;
    return `${header}\n${renderBody(m.text)}`;
  };

  return { format };
}

export function paintWith(
  color: boolean,
): (c: AnsiColor, s: string) => string {
  return (c, s) => (color ? `${ANSI[c]}${s}${ANSI.reset}` : s);
}
