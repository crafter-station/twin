import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import pc from "picocolors";
import { getPeer } from "../core/config.ts";
import { TwinError } from "../core/errors.ts";
import type { Direction } from "../core/merge.ts";
import { PATHS, TWIN_DIR } from "../core/paths.ts";
import { parseScopes, type ScopeName } from "../core/scopes.ts";
import { type SyncReport, sync } from "../core/sync.ts";
import { duration, emit, spinner, ui } from "../ui/out.ts";

type SyncFlags = {
  on?: string;
  only?: string;
  dryRun?: boolean;
  force?: boolean;
  verbose?: boolean;
  ifReachable?: boolean;
};

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function withLock<T>(work: () => Promise<T>): Promise<T> {
  if (existsSync(PATHS.lock)) {
    const pid = Number(readFileSync(PATHS.lock, "utf8"));
    if (pid && alive(pid)) {
      throw new TwinError("busy", `A sync is already running (pid ${pid}).`);
    }
  }
  mkdirSync(TWIN_DIR, { recursive: true });
  writeFileSync(PATHS.lock, String(process.pid));
  return work().finally(() => {
    if (existsSync(PATHS.lock)) unlinkSync(PATHS.lock);
  });
}

const count = (n: number, arrow: string) =>
  n === 0 ? pc.dim("·") : `${arrow} ${n}`;

export function printReport(report: SyncReport, verbose = false) {
  const verb = report.dryRun
    ? "dry run"
    : { both: "sync", push: "push", pull: "pull" }[report.direction];
  ui.head(
    `twin ${verb}`,
    `${report.peer} via ${report.route.kind} · ${report.route.ms} ms`,
  );
  for (const s of report.scopes) {
    ui.row(
      [
        pc.bold(s.scope),
        count(s.up, pc.cyan("↑")),
        count(s.down, pc.magenta("↓")),
      ],
      [10, 8, 8],
    );
    if (verbose) {
      for (const f of s.files.up.slice(0, 12))
        ui.say(`    ${pc.cyan("↑")} ${pc.dim(f)}`);
      for (const f of s.files.down.slice(0, 12))
        ui.say(`    ${pc.magenta("↓")} ${pc.dim(f)}`);
    }
  }
  const total = report.scopes.reduce((n, s) => n + s.up + s.down, 0);
  ui.gap();
  if (total === 0) ui.ok(`Already in sync ${pc.dim(duration(report.ms))}`);
  else if (report.dryRun) ui.hint(`Run ${pc.bold("twin sync")} to apply`);
  else
    ui.ok(
      `Synced ${total} ${total === 1 ? "change" : "changes"} in ${duration(report.ms)}`,
    );
  ui.gap();
}

export async function syncCommand(direction: Direction, flags: SyncFlags) {
  const peer = getPeer(flags.on);
  const scopes: ScopeName[] = parseScopes(flags.only);
  const spin = spinner(`Syncing with ${peer.name}`);
  try {
    const report = await withLock(() =>
      sync(peer, {
        scopes,
        direction,
        dryRun: Boolean(flags.dryRun),
        force: flags.force,
        onScope: (scope) => spin.update(`Syncing ${scope} with ${peer.name}`),
      }),
    );
    spin.stop();
    emit({ ok: true, ...report });
    printReport(report, flags.verbose);
  } catch (error) {
    spin.stop();
    if (
      flags.ifReachable &&
      error instanceof TwinError &&
      error.code === "unreachable"
    ) {
      emit({ ok: true, skipped: "unreachable", peer: peer.name });
      return;
    }
    throw error;
  }
}
