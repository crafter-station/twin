import pc from "picocolors";
import { allPeers, getPeer, type Peer } from "../core/config.ts";
import { type Check, diagnose } from "../core/doctor.ts";
import { TwinError } from "../core/errors.ts";
import { isLoadedLocal, SYNC_LABEL } from "../core/launchd.ts";
import { resolveRoute } from "../core/net.ts";
import { probeRemote } from "../core/probe.ts";
import { loadState } from "../core/state.ts";
import { sync } from "../core/sync.ts";
import { ago, emit, isJson, spinner, ui } from "../ui/out.ts";

async function peerStatus(peer: Peer, pending: boolean) {
  const last = loadState().lastSync[peer.name];
  try {
    const route = await resolveRoute(peer);
    const info = await probeRemote(peer);
    const diff = pending
      ? await sync(peer, {
          scopes: ["config", "sessions", "history", "mcp"],
          direction: "both",
          dryRun: true,
        })
      : undefined;
    return {
      name: peer.name,
      online: true,
      route,
      claude: info.version,
      loggedIn: info.loggedIn,
      remoteControl: info.rc,
      jobsRunning: info.jobsRunning,
      lastSync: last,
      pending: diff
        ? {
            up: diff.scopes.reduce((n, s) => n + s.up, 0),
            down: diff.scopes.reduce((n, s) => n + s.down, 0),
          }
        : undefined,
    };
  } catch (error) {
    if (!(error instanceof TwinError)) throw error;
    return {
      name: peer.name,
      online: false,
      lastSync: last,
      error: error.message,
    };
  }
}

export async function status(flags: { on?: string; fast?: boolean }) {
  const peers = flags.on ? [getPeer(flags.on)] : allPeers();
  if (peers.length === 0) getPeer();
  const spin = spinner("Checking your Macs");
  const [rows, auto] = await Promise.all([
    Promise.all(peers.map((p) => peerStatus(p, !flags.fast))),
    isLoadedLocal(SYNC_LABEL),
  ]);
  spin.stop();
  emit({ ok: true, autoSync: auto, peers: rows });
  if (isJson()) return;

  ui.head("twin status");
  for (const r of rows) {
    if (!("route" in r) || !r.route) {
      ui.row(
        [
          pc.bold(r.name),
          pc.red("offline"),
          pc.dim(`last sync ${ago(r.lastSync?.at)}`),
        ],
        [10, 22, 0],
      );
      continue;
    }
    ui.row(
      [
        pc.bold(r.name),
        `${pc.green("●")} ${r.route.kind} ${pc.dim(`${r.route.ms} ms`)}`,
        r.claude ? `claude ${r.claude}` : pc.yellow("no claude"),
        r.loggedIn ? "" : pc.yellow("signed out"),
      ],
      [10, 22, 18, 10],
    );
    ui.row(["", pc.dim("last sync"), ago(r.lastSync?.at)], [10, 22, 0]);
    if (r.pending) {
      const { up, down } = r.pending;
      ui.row(
        [
          "",
          pc.dim("pending"),
          up + down === 0
            ? pc.green("in sync")
            : `${pc.cyan("↑")} ${up}  ${pc.magenta("↓")} ${down}`,
        ],
        [10, 22, 0],
      );
    }
    ui.row(
      [
        "",
        pc.dim("jobs"),
        r.jobsRunning ? `${r.jobsRunning} running` : pc.dim("none running"),
      ],
      [10, 22, 0],
    );
    ui.row(
      [
        "",
        pc.dim("remote control"),
        r.remoteControl ? pc.green("always on") : pc.dim("off"),
      ],
      [10, 22, 0],
    );
  }
  ui.gap();
  ui.row(
    [
      pc.bold("auto sync"),
      auto ? pc.green("on") : pc.dim("off · twin auto on"),
    ],
    [10, 0],
  );
  ui.gap();
}

const MARK: Record<Check["level"], string> = {
  ok: pc.green("✓"),
  warn: pc.yellow("!"),
  error: pc.red("✗"),
};

export async function doctor(flags: { on?: string; fix?: boolean }) {
  const peer = flags.on ? getPeer(flags.on) : undefined;
  const spin = spinner("Running checks");
  let checks = await diagnose(peer);
  spin.stop();

  const fixed: string[] = [];
  if (flags.fix) {
    for (const check of checks) {
      if (check.level === "ok" || !check.fix) continue;
      const s = spinner(`${check.scope}: ${check.fix.label}`);
      await check.fix.apply();
      s.stop();
      fixed.push(`${check.scope}: ${check.fix.label}`);
    }
    if (fixed.length > 0) checks = await diagnose(peer);
  }

  const problems = checks.filter((c) => c.level !== "ok");
  emit({
    ok: problems.every((c) => c.level !== "error"),
    fixed,
    checks: checks.map(({ fix, ...c }) => ({ ...c, fixable: Boolean(fix) })),
  });
  if (isJson()) return;

  ui.head("twin doctor");
  let scope = "";
  for (const c of checks) {
    if (c.scope !== scope) {
      scope = c.scope;
      ui.say(`  ${pc.bold(scope)}`);
    }
    ui.say(`    ${MARK[c.level]} ${c.title}`);
    if (c.level !== "ok" && c.detail) ui.say(`      ${pc.dim(c.detail)}`);
    if (c.level !== "ok" && c.hint) ui.say(`      ${pc.dim("→")} ${c.hint}`);
    if (c.level !== "ok" && c.fix)
      ui.say(`      ${pc.dim(`→ fixable: ${c.fix.label}`)}`);
  }
  ui.gap();
  for (const f of fixed) ui.ok(`Fixed ${f}`);
  if (problems.some((c) => c.fix) && !flags.fix) {
    ui.hint(`Run ${pc.bold("twin doctor --fix")} to fix what can be fixed`);
  } else if (problems.length === 0) {
    ui.ok("Everything looks good");
  }
  ui.gap();
}
