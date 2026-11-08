import pc from "picocolors";
import type { ResultEvent } from "../core/jobs.ts";
import { duration, money, plural, say } from "./out.ts";

type Block = {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
};

type StreamEvent = {
  type: string;
  subtype?: string;
  model?: string;
  message?: { content?: Block[] };
};

const SUMMARY_KEYS = [
  "command",
  "file_path",
  "pattern",
  "url",
  "query",
  "description",
  "prompt",
];

function toolSummary(input: Record<string, unknown> = {}) {
  for (const key of SUMMARY_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      const flat = value.replace(/\s+/g, " ").trim();
      return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
    }
  }
  return "";
}

export function resultLine(r: ResultEvent) {
  const mark = r.is_error ? pc.red("✗ failed") : pc.green("✓ done");
  const facts = [
    duration(r.duration_ms),
    money(r.total_cost_usd),
    r.num_turns ? plural(r.num_turns, "turn") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `  ${mark}  ${pc.dim(facts)}`;
}

export function renderEvent(line: string, where: string) {
  let event: StreamEvent;
  try {
    event = JSON.parse(line) as StreamEvent;
  } catch {
    return;
  }
  if (event.type === "system" && event.subtype === "init") {
    const model = event.model ? pc.dim(` · ${event.model}`) : "";
    say(`  ${pc.cyan("●")} started on ${pc.bold(where)}${model}`);
    return;
  }
  if (event.type === "assistant") {
    for (const block of event.message?.content ?? []) {
      if (block.type === "text" && block.text?.trim()) {
        say(`\n${block.text.trim().replace(/^/gm, "  ")}\n`);
      }
      if (block.type === "tool_use" && block.name) {
        say(
          `  ${pc.dim("›")} ${pc.bold(block.name)} ${pc.dim(toolSummary(block.input))}`,
        );
      }
    }
    return;
  }
  if (event.type === "result") say(`\n${resultLine(event as ResultEvent)}`);
}
