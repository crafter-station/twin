import pc from "picocolors";
import { TwinError } from "../core/errors.ts";

const mode = { json: false, quiet: false };

export const setMode = (next: Partial<typeof mode>) =>
  Object.assign(mode, next);
export const isJson = () => mode.json;
export const isQuiet = () => mode.quiet || mode.json;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const CLEAR = `\r${ESC}[2K`;

export const visible = (s: string) => s.replace(ANSI, "").length;
export const pad = (s: string, width: number) =>
  s + " ".repeat(Math.max(0, width - visible(s)));

export function say(text = "") {
  if (!isQuiet()) process.stdout.write(`${text}\n`);
}

export const ui = {
  say,
  head: (title: string, detail?: string) =>
    say(`\n${pc.bold(title)}${detail ? pc.dim(`  ${detail}`) : ""}\n`),
  ok: (text: string) => say(`  ${pc.green("✓")} ${text}`),
  warn: (text: string) => say(`  ${pc.yellow("!")} ${text}`),
  fail: (text: string) => say(`  ${pc.red("✗")} ${text}`),
  info: (text: string) => say(`  ${pc.dim("·")} ${text}`),
  hint: (text: string) => say(`  ${pc.dim("→")} ${text}`),
  row: (cells: string[], widths: number[]) =>
    say(
      `  ${cells
        .map((c, i) => pad(c, widths[i] ?? 0))
        .join("  ")
        .trimEnd()}`,
    ),
  gap: () => say(),
};

export function emit(data: unknown) {
  if (mode.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(text: string) {
  const live = !isQuiet() && process.stderr.isTTY;
  let label = text;
  let frame = 0;
  const draw = () =>
    process.stderr.write(
      `${CLEAR}  ${pc.cyan(FRAMES[frame++ % FRAMES.length] ?? "")} ${label}`,
    );
  const timer = live ? setInterval(draw, 80) : undefined;
  if (live) draw();
  return {
    update: (next: string) => {
      label = next;
    },
    stop: () => {
      if (!live) return;
      clearInterval(timer);
      process.stderr.write(CLEAR);
    },
  };
}

export function fail(error: unknown): never {
  const known = error instanceof TwinError;
  const code = known ? error.code : "error";
  const message = error instanceof Error ? error.message : String(error);
  const hint = known ? error.hint : undefined;
  if (mode.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code, message, hint } }, null, 2)}\n`,
    );
  } else {
    process.stderr.write(`\n  ${pc.red("✗")} ${message}\n`);
    if (hint) process.stderr.write(`  ${pc.dim("→")} ${hint}\n`);
    process.stderr.write("\n");
  }
  process.exit(known ? error.exitCode : 1);
}

export function ago(iso?: string) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function duration(ms?: number) {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export const plural = (n: number, word: string) =>
  `${n} ${n === 1 ? word : `${word}s`}`;

export const money = (usd?: number) =>
  usd === undefined ? "" : `≈$${usd.toFixed(2)} API est.`;
