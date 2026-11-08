import { existsSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { getPeer } from "../core/config.ts";
import { fromHome, isInsideHome } from "../core/paths.ts";
import { transfer } from "../core/rsync.ts";
import { PROJECT_EXCLUDES } from "../core/scopes.ts";
import { sh, shq, shTty } from "../core/ssh.ts";
import { plural, spinner, ui } from "../ui/out.ts";

const here = () => {
  const cwd = process.cwd();
  return isInsideHome(cwd) ? fromHome(cwd) : "";
};

const enter = (rel: string) =>
  rel ? `cd "$HOME"/${shq(rel)} 2>/dev/null || cd "$HOME"` : `cd "$HOME"`;

export async function shellCommand(flags: { on?: string }) {
  const peer = getPeer(flags.on);
  process.exitCode = await shTty(peer, `${enter(here())}; exec "$SHELL" -l`);
}

export async function claudeCommand(
  args: string[],
  flags: { on?: string; copy?: boolean },
) {
  const peer = getPeer(flags.on);
  const rel = here();
  const isProject = rel && existsSync(join(process.cwd(), ".git"));
  if (isProject && flags.copy !== false) {
    const spin = spinner(`Copying ${rel} to ${peer.name}`);
    await sh(peer, `mkdir -p "$HOME"/${shq(rel)}`);
    const copied = await transfer(peer, {
      from: "local",
      path: rel,
      dir: true,
      excludes: PROJECT_EXCLUDES,
    });
    spin.stop();
    if (copied.length)
      ui.info(`${plural(copied.length, "file")} copied to ${peer.name}`);
  }
  const passthrough = args.map(shq).join(" ");
  process.exitCode = await shTty(
    peer,
    `${enter(rel)}; exec claude ${passthrough}`,
  );
  if (isProject) {
    ui.hint(`Bring the changes back with ${pc.bold("twin fetch --here")}`);
  }
}

export async function loginCommand(flags: { on?: string }) {
  const peer = getPeer(flags.on);
  ui.gap();
  ui.info(
    `Signing in to Claude Code on ${pc.bold(peer.name)}. Open the link it prints on this Mac.`,
  );
  ui.gap();
  process.exitCode = await shTty(peer, "claude auth login");
}
