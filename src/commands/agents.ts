import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pc from "picocolors";
import { getPeer, type Peer } from "../core/config.ts";
import { TwinError } from "../core/errors.ts";
import {
  installLocal,
  installRemote,
  isLoadedLocal,
  RC_LABEL,
  removeLocal,
  removeRemote,
  SYNC_LABEL,
} from "../core/launchd.ts";
import { readRemoteClaudeJson, writeRemoteClaudeJson } from "../core/merge.ts";
import {
  CLAUDE_DIR,
  fromHome,
  isInsideHome,
  PATHS,
  REMOTE_ENV,
} from "../core/paths.ts";
import { probeRemote } from "../core/probe.ts";
import { selfCommand, skillText } from "../core/self.ts";
import { sh, shq, shTty } from "../core/ssh.ts";
import { emit, plain, spinner, ui } from "../ui/out.ts";

const SKILL_TARGET = join(CLAUDE_DIR, "skills", "twin", "SKILL.md");

export function installSkill() {
  const text = skillText();
  if (!text) {
    throw new TwinError(
      "no_skill",
      "The twin skill file is missing from this install.",
      "Reinstall twin.",
    );
  }
  mkdirSync(dirname(SKILL_TARGET), { recursive: true });
  writeFileSync(SKILL_TARGET, text);
  return SKILL_TARGET;
}

export function skillCommand() {
  const path = installSkill();
  emit({ ok: true, path });
  ui.gap();
  ui.ok(`Installed the twin skill at ${pc.dim(path)}`);
  ui.hint("Every Claude session now knows how to sync and delegate with twin");
  ui.gap();
}

export async function enableAuto(minutes: number) {
  await installLocal({
    label: SYNC_LABEL,
    args: [...selfCommand(), "sync", "--quiet", "--if-reachable"],
    interval: minutes * 60,
    log: join(PATHS.logs, "auto.log"),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
}

export async function autoCommand(
  action: string | undefined,
  flags: { every?: string },
) {
  const minutes = Number(flags.every ?? 5);
  if (action === "on") {
    mkdirSync(PATHS.logs, { recursive: true });
    await enableAuto(minutes);
    emit({ ok: true, autoSync: true, everyMinutes: minutes });
    ui.gap();
    ui.ok(
      `Auto sync is on, every ${minutes} min while the other Mac is reachable`,
    );
    ui.hint(`Log: ${pc.dim(join(PATHS.logs, "auto.log"))}`);
    ui.gap();
    return;
  }
  if (action === "off") {
    await removeLocal(SYNC_LABEL);
    emit({ ok: true, autoSync: false });
    ui.gap();
    ui.ok("Auto sync is off");
    ui.gap();
    return;
  }
  const on = await isLoadedLocal(SYNC_LABEL);
  emit({ ok: true, autoSync: on });
  ui.gap();
  ui.say(`  auto sync ${on ? pc.green("on") : pc.dim("off")}`);
  ui.gap();
}

async function trust(peer: Peer, dir: string) {
  const data = await readRemoteClaudeJson(peer);
  const projects = data.projects ?? {};
  const current = projects[dir] ?? {};
  if (current.hasTrustDialogAccepted === true) return;
  projects[dir] = { ...current, hasTrustDialogAccepted: true };
  await writeRemoteClaudeJson(peer, { ...data, projects });
}

export async function enableRc(peer: Peer, rel: string, mode: string) {
  await trust(peer, rel ? `${peer.home}/${rel}` : peer.home);
  const cd = rel ? `cd "$HOME"/${shq(rel)}` : `cd "$HOME"`;
  await installRemote(peer, {
    label: RC_LABEL,
    args: [
      "/bin/sh",
      "-c",
      `${REMOTE_ENV}; ${cd} && exec claude remote-control --name ${shq(peer.name)} --permission-mode ${shq(mode)}`,
    ],
    keepAlive: true,
    log: `${peer.home}/.twin/rc.log`,
    env: { HOME: peer.home },
  });
}

const CONSENT = /got no answer/;

async function startRc(peer: Peer, rel: string, mode: string) {
  await sh(peer, 'mkdir -p "$HOME/.twin" && : > "$HOME/.twin/rc.log"');
  await enableRc(peer, rel, mode);
  await new Promise((r) => setTimeout(r, 6000));
  return (await sh(peer, 'tail -n 30 "$HOME/.twin/rc.log" 2>/dev/null')).stdout;
}

export async function rcCommand(
  action: string | undefined,
  flags: { on?: string; dir?: string; mode?: string },
) {
  const peer = getPeer(flags.on);
  if (action === "on") {
    const cwd = process.cwd();
    const rel = flags.dir ?? (isInsideHome(cwd) ? fromHome(cwd) : "");
    const mode = flags.mode ?? "auto";
    const spin = spinner(`Starting Remote Control on ${peer.name}`);
    let log = await startRc(peer, rel, mode);
    spin.stop();
    if (CONSENT.test(log)) {
      if (!process.stdin.isTTY) {
        throw new TwinError(
          "needs_consent",
          `Claude Code on ${peer.name} asks once before enabling Remote Control.`,
          "Run `twin rc on` in a terminal tab and answer y.",
        );
      }
      ui.gap();
      ui.info(
        `Claude Code on ${pc.bold(peer.name)} asks once before enabling Remote Control.`,
      );
      ui.info(
        `Answer ${pc.bold("y")}, wait for the link, then press ${pc.bold("Ctrl+C")}.`,
      );
      ui.gap();
      await removeRemote(peer, RC_LABEL);
      const cd = rel ? `cd "$HOME"/${shq(rel)}` : `cd "$HOME"`;
      await shTty(
        peer,
        `${cd} && claude remote-control --name ${shq(peer.name)}`,
        {
          unlock: true,
        },
      );
      const again = spinner(`Starting Remote Control on ${peer.name}`);
      log = await startRc(peer, rel, mode);
      again.stop();
      if (CONSENT.test(log)) {
        throw new TwinError(
          "needs_consent",
          "Remote Control is still waiting for a yes.",
          "Run `twin rc on` again and answer y.",
        );
      }
    }
    emit({ ok: true, remoteControl: true, dir: rel || "~", log });
    ui.gap();
    ui.ok(`Remote Control is always on for ${pc.bold(peer.name)} in ~/${rel}`);
    ui.hint(
      `Open claude.ai/code or the Claude app and pick ${pc.bold(peer.name)}`,
    );
    ui.hint("It restarts by itself after crashes and reboots");
    ui.gap();
    return;
  }
  if (action === "off") {
    await removeRemote(peer, RC_LABEL);
    emit({ ok: true, remoteControl: false });
    ui.gap();
    ui.ok(`Remote Control is off on ${peer.name}`);
    ui.gap();
    return;
  }
  if (action === "logs") {
    const log = (await sh(peer, 'tail -n 60 "$HOME/.twin/rc.log" 2>/dev/null'))
      .stdout;
    const clean = plain(log);
    emit({ ok: true, log: clean });
    ui.say(clean);
    return;
  }
  const info = await probeRemote(peer);
  emit({ ok: true, remoteControl: info.rc });
  ui.gap();
  ui.say(
    `  remote control on ${peer.name} ${info.rc ? pc.green("always on") : pc.dim("off · twin rc on")}`,
  );
  ui.gap();
}
