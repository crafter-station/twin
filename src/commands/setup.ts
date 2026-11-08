import pc from "picocolors";
import { getPeer } from "../core/config.ts";
import {
  cleanupDays,
  diagnose,
  KEEP_DAYS,
  keepHistoryForever,
} from "../core/doctor.ts";
import { fromHome, HOME, isInsideHome } from "../core/paths.ts";
import { probeRemote } from "../core/probe.ts";
import { sync } from "../core/sync.ts";
import { emit, spinner, ui } from "../ui/out.ts";
import { enableAuto, enableRc, installSkill } from "./agents.ts";
import { printReport } from "./sync.ts";

type SetupFlags = { on?: string; auto?: boolean; rc?: boolean; rcDir?: string };

export async function setup(flags: SetupFlags) {
  const peer = getPeer(flags.on);
  const steps: { step: string; ok: boolean; note?: string }[] = [];
  const done = (step: string, ok = true, note?: string) => {
    steps.push({ step, ok, note });
    ui[ok ? "ok" : "warn"](`${step}${note ? pc.dim(` · ${note}`) : ""}`);
  };

  ui.head("twin setup", `making ${peer.name} match this Mac`);

  if ((cleanupDays() ?? 30) < 365) keepHistoryForever();
  done(`Sessions kept ${KEEP_DAYS} days on both Macs`);

  installSkill();
  done("Installed the twin skill");

  const spin = spinner(`Checking ${peer.name}`);
  for (const check of await diagnose(peer)) {
    if (check.level === "ok" || !check.fix || check.id === "remote-retention")
      continue;
    spin.update(`${peer.name}: ${check.fix.label}`);
    await check.fix.apply();
    spin.stop();
    done(check.fix.label);
  }
  spin.update(`Copying your setup to ${peer.name}`);

  const first = await sync(peer, {
    scopes: ["config", "mcp"],
    direction: "push",
    dryRun: false,
    force: true,
  });
  spin.update(`Copying sessions and memory to ${peer.name}`);
  const rest = await sync(peer, {
    scopes: ["sessions", "history"],
    direction: "push",
    dryRun: false,
  });
  spin.stop();
  printReport({
    ...rest,
    scopes: [...first.scopes, ...rest.scopes],
    ms: first.ms + rest.ms,
  });

  if (flags.auto !== false) {
    await enableAuto(5);
    done("Auto sync on, every 5 min");
  }

  const info = await probeRemote(peer);
  if (!info.loggedIn) {
    done(
      `${peer.name} is not signed in to Claude yet`,
      false,
      `run ${pc.bold("twin login")}, then ${pc.bold("twin rc on")}`,
    );
  } else if (flags.rc !== false) {
    const cwd = process.cwd();
    const rel = flags.rcDir ?? (isInsideHome(cwd) ? fromHome(cwd) : "");
    await enableRc(peer, rel, "auto");
    done(`Remote Control always on in ~/${rel || ""}`.replace(`${HOME}/`, ""));
  }

  emit({
    ok: true,
    peer: peer.name,
    steps,
    synced: [...first.scopes, ...rest.scopes],
  });
  ui.gap();
  ui.hint(`${pc.bold('twin run "<task>"')} sends work to ${peer.name}`);
  ui.hint(`${pc.bold("twin status")} shows both Macs at a glance`);
  ui.gap();
}
