import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Peer } from "./config.ts";
import { CLAUDE_DIR, CLAUDE_JSON } from "./paths.ts";
import { sh, shOk } from "./ssh.ts";
import { readJson, writeJson, writeText } from "./store.ts";

export type Direction = "push" | "pull" | "both";
export type MergeCount = { up: number; down: number; items: string[] };

const HISTORY = join(CLAUDE_DIR, "history.jsonl");

const toLines = (text: string) => text.split("\n").filter((l) => l.trim());

function timestamp(line: string): number {
  const match = line.match(/"timestamp":(\d+)/);
  return match ? Number(match[1]) : 0;
}

export async function mergeHistory(
  peer: Peer,
  direction: Direction,
  dryRun: boolean,
): Promise<MergeCount> {
  const local = existsSync(HISTORY)
    ? toLines(readFileSync(HISTORY, "utf8"))
    : [];
  const remote = toLines(
    (await sh(peer, 'cat "$HOME/.claude/history.jsonl" 2>/dev/null')).stdout,
  );
  const localSet = new Set(local);
  const remoteSet = new Set(remote);
  const down =
    direction === "push" ? [] : remote.filter((l) => !localSet.has(l));
  const up = direction === "pull" ? [] : local.filter((l) => !remoteSet.has(l));

  if (!dryRun && (up.length > 0 || down.length > 0)) {
    const merged = `${[...new Set([...local, ...remote])]
      .sort((a, b) => timestamp(a) - timestamp(b))
      .join("\n")}\n`;
    if (down.length > 0) writeText(HISTORY, merged);
    if (up.length > 0) {
      await shOk(
        peer,
        'mkdir -p "$HOME/.claude" && cat > "$HOME/.claude/history.jsonl.twin" && mv "$HOME/.claude/history.jsonl.twin" "$HOME/.claude/history.jsonl"',
        { input: merged },
      );
    }
  }
  return { up: up.length, down: down.length, items: [] };
}

type ClaudeJson = {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export async function readRemoteClaudeJson(peer: Peer): Promise<ClaudeJson> {
  const raw = (await sh(peer, 'cat "$HOME/.claude.json" 2>/dev/null')).stdout;
  try {
    return raw.trim() ? (JSON.parse(raw) as ClaudeJson) : {};
  } catch {
    return {};
  }
}

export async function writeRemoteClaudeJson(peer: Peer, data: ClaudeJson) {
  await shOk(
    peer,
    'mkdir -p "$HOME/.twin/backups" && { [ -f "$HOME/.claude.json" ] && cp "$HOME/.claude.json" "$HOME/.twin/backups/claude.json.$(date +%s)"; true; } && cat > "$HOME/.claude.json.twin" && mv "$HOME/.claude.json.twin" "$HOME/.claude.json"',
    { input: `${JSON.stringify(data, null, 2)}\n` },
  );
}

export async function mergeMcp(
  peer: Peer,
  direction: Direction,
  dryRun: boolean,
): Promise<MergeCount> {
  const local = readJson<ClaudeJson>(CLAUDE_JSON, {});
  const remote = await readRemoteClaudeJson(peer);
  const mine = local.mcpServers ?? {};
  const theirs = remote.mcpServers ?? {};
  const remoteWins = direction === "pull";

  const up =
    direction === "pull"
      ? []
      : Object.keys(mine).filter(
          (name) =>
            !(name in theirs) ||
            (!remoteWins && !same(mine[name], theirs[name])),
        );
  const down =
    direction === "push"
      ? []
      : Object.keys(theirs).filter(
          (name) =>
            !(name in mine) || (remoteWins && !same(mine[name], theirs[name])),
        );

  if (!dryRun) {
    const merged = remoteWins ? { ...mine, ...theirs } : { ...theirs, ...mine };
    if (down.length > 0)
      writeJson(CLAUDE_JSON, {
        ...readJson<ClaudeJson>(CLAUDE_JSON, {}),
        mcpServers: merged,
      });
    if (up.length > 0)
      await writeRemoteClaudeJson(peer, { ...remote, mcpServers: merged });
  }
  return { up: up.length, down: down.length, items: [...up, ...down] };
}
