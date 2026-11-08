import { allPeers, type Peer } from "./config.ts";
import { TwinError } from "./errors.ts";
import { isLoadedLocal, SYNC_LABEL } from "./launchd.ts";
import { resolveRoute } from "./net.ts";
import { HOME, SETTINGS } from "./paths.ts";
import { probeRemote } from "./probe.ts";
import { run } from "./proc.ts";
import { sh, shOk } from "./ssh.ts";
import { readJson, writeJson } from "./store.ts";
import { sync } from "./sync.ts";

export type Level = "ok" | "warn" | "error";

export type Check = {
  id: string;
  scope: string;
  level: Level;
  title: string;
  detail?: string;
  hint?: string;
  fix?: { label: string; apply: () => Promise<void> };
};

export const KEEP_DAYS = 3650;
const MIN_DAYS = 365;

const INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";

export function cleanupDays(): number | undefined {
  return readJson<{ cleanupPeriodDays?: number }>(SETTINGS, {})
    .cleanupPeriodDays;
}

export function keepHistoryForever() {
  const settings = readJson<Record<string, unknown>>(SETTINGS, {});
  writeJson(SETTINGS, { ...settings, cleanupPeriodDays: KEEP_DAYS });
}

async function localChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const version = await run("claude", ["--version"]);
  checks.push(
    version.code === 0
      ? {
          id: "claude",
          scope: "this Mac",
          level: "ok",
          title: `Claude Code ${version.stdout.trim().split(" ")[0]}`,
        }
      : {
          id: "claude",
          scope: "this Mac",
          level: "error",
          title: "Claude Code is not installed",
          hint: INSTALL,
        },
  );

  const days = cleanupDays();
  checks.push(
    (days ?? 30) >= MIN_DAYS
      ? {
          id: "retention",
          scope: "this Mac",
          level: "ok",
          title: `Sessions kept ${days} days`,
        }
      : {
          id: "retention",
          scope: "this Mac",
          level: "error",
          title: `Sessions are deleted after ${days ?? 30} days`,
          detail: "Claude Code removes old transcripts by default.",
          fix: {
            label: `set cleanupPeriodDays to ${KEEP_DAYS}`,
            apply: async () => keepHistoryForever(),
          },
        },
  );

  const peers = allPeers();
  checks.push(
    peers.length > 0
      ? {
          id: "peers",
          scope: "this Mac",
          level: "ok",
          title: `Paired with ${peers.map((p) => p.name).join(", ")}`,
        }
      : {
          id: "peers",
          scope: "this Mac",
          level: "error",
          title: "No Mac paired yet",
          hint: "twin pair",
        },
  );

  if (peers.length > 0) {
    checks.push(
      (await isLoadedLocal(SYNC_LABEL))
        ? {
            id: "auto",
            scope: "this Mac",
            level: "ok",
            title: "Auto sync is on",
          }
        : {
            id: "auto",
            scope: "this Mac",
            level: "warn",
            title: "Auto sync is off",
            hint: "twin auto on",
          },
    );
  }
  return checks;
}

async function peerChecks(peer: Peer): Promise<Check[]> {
  const scope = peer.name;
  const checks: Check[] = [];
  try {
    const route = await resolveRoute(peer);
    checks.push({
      id: "route",
      scope,
      level: "ok",
      title: `Reachable via ${route.kind} (${route.ms} ms)`,
      detail: route.address,
    });
  } catch (error) {
    const hint = error instanceof TwinError ? error.hint : undefined;
    return [
      { id: "route", scope, level: "error", title: "Not reachable", hint },
    ];
  }

  if ((await sh(peer, "true", { timeoutMs: 10_000 })).code !== 0) {
    return [
      ...checks,
      {
        id: "ssh",
        scope,
        level: "error",
        title: "SSH key is not authorized",
        hint: "twin pair",
      },
    ];
  }

  const info = await probeRemote(peer);
  checks.push(
    info.home === HOME
      ? { id: "paths", scope, level: "ok", title: `Same home folder (${HOME})` }
      : {
          id: "paths",
          scope,
          level: "error",
          title: `Home folder differs (${info.home})`,
          detail:
            "Sessions are filed by full path, so they only resume when both Macs use the same username.",
        },
  );

  if (!info.claude) {
    checks.push({
      id: "remote-claude",
      scope,
      level: "error",
      title: "Claude Code is not installed",
      fix: {
        label: "install Claude Code",
        apply: async () =>
          void (await shOk(peer, INSTALL, { timeoutMs: 300_000 })),
      },
    });
  } else {
    const local = (await run("claude", ["--version"])).stdout
      .trim()
      .split(" ")[0];
    checks.push(
      info.version === local
        ? {
            id: "remote-claude",
            scope,
            level: "ok",
            title: `Claude Code ${info.version}`,
          }
        : {
            id: "remote-claude",
            scope,
            level: "warn",
            title: `Claude Code ${info.version}, this Mac has ${local}`,
            fix: {
              label: "update Claude Code",
              apply: async () =>
                void (await sh(peer, "claude update", { timeoutMs: 300_000 })),
            },
          },
    );
    checks.push(
      info.loggedIn
        ? { id: "login", scope, level: "ok", title: "Signed in" }
        : {
            id: "login",
            scope,
            level: "error",
            title: "Not signed in",
            hint: "twin login",
          },
    );
  }

  checks.push(
    (info.cleanupDays ?? 30) >= MIN_DAYS
      ? {
          id: "remote-retention",
          scope,
          level: "ok",
          title: `Sessions kept ${info.cleanupDays} days`,
        }
      : {
          id: "remote-retention",
          scope,
          level: "error",
          title: `Sessions are deleted after ${info.cleanupDays ?? 30} days`,
          fix: {
            label: "push settings",
            apply: async () => {
              if ((cleanupDays() ?? 30) < MIN_DAYS) keepHistoryForever();
              await sync(peer, {
                scopes: ["config"],
                direction: "push",
                dryRun: false,
              });
            },
          },
        },
  );

  checks.push(
    info.sleepMinutes === 0
      ? { id: "sleep", scope, level: "ok", title: "Never sleeps" }
      : {
          id: "sleep",
          scope,
          level: "warn",
          title: `Sleeps after ${info.sleepMinutes ?? "?"} min`,
          detail:
            "Jobs keep it awake while they run, but Remote Control and auto sync need it awake.",
          hint: `ssh ${peer.name} -t sudo pmset -a sleep 0`,
        },
  );

  checks.push(
    info.rc
      ? { id: "rc", scope, level: "ok", title: "Remote Control is always on" }
      : {
          id: "rc",
          scope,
          level: "warn",
          title: "Remote Control is off",
          hint: "twin rc on",
        },
  );
  return checks;
}

export async function diagnose(only?: Peer): Promise<Check[]> {
  const local = await localChecks();
  const peers = only ? [only] : allPeers();
  const remote = await Promise.all(peers.map(peerChecks));
  return [...local, ...remote.flat()];
}
