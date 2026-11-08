import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Peer } from "./config.ts";
import { type Direction, mergeHistory, mergeMcp } from "./merge.ts";
import { type Route, resolveRoute } from "./net.ts";
import { HOME, PATHS, stamp } from "./paths.ts";
import { transfer } from "./rsync.ts";
import { FILE_SCOPES, type ScopeName } from "./scopes.ts";
import { sh, shq } from "./ssh.ts";
import { updateState } from "./state.ts";

export type ScopeReport = {
  scope: ScopeName;
  up: number;
  down: number;
  files: { up: string[]; down: string[] };
};

export type SyncReport = {
  peer: string;
  route: Route;
  direction: Direction;
  dryRun: boolean;
  scopes: ScopeReport[];
  ms: number;
};

type SyncOptions = {
  scopes: ScopeName[];
  direction: Direction;
  dryRun: boolean;
  force?: boolean;
  onScope?: (scope: ScopeName) => void;
};

const BACKUP_DAYS = 14;

async function remoteExisting(
  peer: Peer,
  paths: string[],
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const list = paths.map(shq).join(" ");
  const { stdout } = await sh(
    peer,
    `for p in ${list}; do [ -e "$HOME/$p" ] && echo "$p"; done; true`,
  );
  return new Set(stdout.split("\n").filter(Boolean));
}

function pruneLocalBackups() {
  if (!existsSync(PATHS.backups)) return;
  const cutoff = Date.now() - BACKUP_DAYS * 86_400_000;
  for (const name of readdirSync(PATHS.backups)) {
    const path = join(PATHS.backups, name);
    if (statSync(path).mtimeMs < cutoff)
      rmSync(path, { recursive: true, force: true });
  }
}

export async function sync(peer: Peer, opts: SyncOptions): Promise<SyncReport> {
  const started = Date.now();
  const route = await resolveRoute(peer);
  const tag = stamp();
  const pushes = opts.direction !== "pull";
  const pulls = opts.direction !== "push";
  const items = opts.scopes.flatMap((s) => FILE_SCOPES[s] ?? []);
  const onRemote = pulls
    ? await remoteExisting(
        peer,
        items.map((i) => i.path),
      )
    : new Set<string>();

  if (pushes && !opts.dryRun) {
    await sh(
      peer,
      `mkdir -p "$HOME/.claude" "$HOME/.agents" "$HOME/.twin"; find "$HOME/.twin/backups" -mindepth 1 -maxdepth 1 -mtime +${BACKUP_DAYS} -exec rm -rf {} + 2>/dev/null; true`,
    );
  }

  const scopes: ScopeReport[] = [];
  for (const scope of opts.scopes) {
    opts.onScope?.(scope);
    const files = FILE_SCOPES[scope];
    if (files) {
      const up: string[] = [];
      const down: string[] = [];
      for (const item of files) {
        const base = { ...item, dryRun: opts.dryRun, backupTag: tag };
        const force = opts.force && opts.direction !== "both";
        if (pushes && existsSync(join(HOME, item.path))) {
          up.push(...(await transfer(peer, { ...base, from: "local", force })));
        }
        if (pulls && onRemote.has(item.path)) {
          down.push(
            ...(await transfer(peer, { ...base, from: "remote", force })),
          );
        }
      }
      scopes.push({
        scope,
        up: up.length,
        down: down.length,
        files: { up, down },
      });
      continue;
    }
    const merge = scope === "history" ? mergeHistory : mergeMcp;
    const count = await merge(peer, opts.direction, opts.dryRun);
    scopes.push({
      scope,
      up: count.up,
      down: count.down,
      files: { up: [], down: [] },
    });
  }

  const report: SyncReport = {
    peer: peer.name,
    route,
    direction: opts.direction,
    dryRun: opts.dryRun,
    scopes,
    ms: Date.now() - started,
  };

  if (!opts.dryRun) {
    pruneLocalBackups();
    updateState((state) => {
      state.lastSync[peer.name] = {
        at: new Date().toISOString(),
        route: route.kind,
        up: scopes.reduce((n, s) => n + s.up, 0),
        down: scopes.reduce((n, s) => n + s.down, 0),
        ms: report.ms,
      };
    });
  }
  return report;
}
