import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Peer } from "./config.ts";
import { type Direction, mergeHistory, mergeMcp } from "./merge.ts";
import { mirror } from "./mirror.ts";
import { type Route, resolveRoute } from "./net.ts";
import { PATHS, stamp } from "./paths.ts";
import { type ProjectReport, syncProjects } from "./projects.ts";
import { FILE_SCOPES, type ScopeName } from "./scopes.ts";
import { sh } from "./ssh.ts";
import { updateState } from "./state.ts";

export type ScopeReport = {
  scope: ScopeName;
  up: number;
  down: number;
  files: { up: string[]; down: string[] };
  projects?: ProjectReport[];
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

function pruneLocalBackups() {
  if (!existsSync(PATHS.backups)) return;
  const cutoff = Date.now() - BACKUP_DAYS * 86_400_000;
  for (const name of readdirSync(PATHS.backups)) {
    const path = join(PATHS.backups, name);
    if (statSync(path).mtimeMs < cutoff) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}

export async function sync(peer: Peer, opts: SyncOptions): Promise<SyncReport> {
  const started = Date.now();
  const route = await resolveRoute(peer);
  const tag = stamp();
  const push = opts.direction !== "pull";
  const pull = opts.direction !== "push";
  const force = opts.force && opts.direction !== "both";

  if (push && !opts.dryRun) {
    await sh(
      peer,
      `mkdir -p "$HOME/.claude" "$HOME/.twin"; find "$HOME/.twin/backups" -mindepth 1 -maxdepth 1 -mtime +${BACKUP_DAYS} -exec rm -rf {} + 2>/dev/null; true`,
    );
  }

  const scopes: ScopeReport[] = [];
  for (const scope of opts.scopes) {
    opts.onScope?.(scope);
    const roots = FILE_SCOPES[scope];
    if (roots) {
      const moved = await mirror(peer, roots, {
        push,
        pull,
        dryRun: opts.dryRun,
        force,
        tag,
      });
      scopes.push({
        scope,
        up: moved.up.length,
        down: moved.down.length,
        files: moved,
      });
      continue;
    }
    if (scope === "projects") {
      const projects = await syncProjects(peer, {
        push,
        pull,
        dryRun: opts.dryRun,
        force,
        tag,
      });
      const list = (pick: (p: ProjectReport) => string[]) =>
        projects.flatMap((p) => pick(p).map((f) => `${p.path}/${f}`));
      const files = { up: list((p) => p.up), down: list((p) => p.down) };
      scopes.push({
        scope,
        up: files.up.length + list((p) => p.deleted.there).length,
        down: files.down.length + list((p) => p.deleted.here).length,
        files,
        projects,
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
