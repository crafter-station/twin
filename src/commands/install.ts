import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { getPeer, type Peer } from "../core/config.ts";
import { TwinError } from "../core/errors.ts";
import { fromHome, TWIN_DIR } from "../core/paths.ts";
import { probeRemote } from "../core/probe.ts";
import { run } from "../core/proc.ts";
import { transfer } from "../core/rsync.ts";
import { isCompiled, skillText, sourceEntry } from "../core/self.ts";
import { sh, shOk, shq } from "../core/ssh.ts";
import { emit, spinner, ui } from "../ui/out.ts";

const VERSION_RE = /\d+\.\d+\.\d+/;

async function buildBinary(arch: string): Promise<string> {
  const target = arch === "arm64" ? "arm64" : "x64";
  const out = join(TWIN_DIR, "build", `twin-darwin-${target}`);
  if (isCompiled() && process.arch === target) return process.execPath;
  if ((await run("bun", ["--version"])).code !== 0) {
    throw new TwinError(
      "no_bun",
      "Installing twin on another Mac needs Bun on this one to build a standalone binary.",
      "curl -fsSL https://bun.sh/install | bash",
    );
  }
  mkdirSync(join(TWIN_DIR, "build"), { recursive: true });
  const result = await run("bun", [
    "build",
    "--compile",
    "--minify",
    `--target=bun-darwin-${target}`,
    sourceEntry(),
    "--outfile",
    out,
  ]);
  if (result.code !== 0) {
    throw new TwinError(
      "build_failed",
      `Building twin failed: ${result.stderr.trim()}`,
    );
  }
  return out;
}

const LOGIN_LOOKUP =
  'env -i HOME="$HOME" USER="$USER" /bin/zsh -lic "command -v twin" 2>/dev/null';
const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

async function ensurePath(peer: Peer): Promise<"ok" | "added"> {
  if ((await sh(peer, LOGIN_LOOKUP)).stdout.includes(".local/bin/twin"))
    return "ok";
  await shOk(
    peer,
    `grep -qs '.local/bin' "$HOME/.zshrc" || printf '\\n%s\\n' ${shq(PATH_LINE)} >> "$HOME/.zshrc"`,
  );
  return "added";
}

export async function installCommand(flags: { on?: string }) {
  const peer = getPeer(flags.on);
  const spin = spinner(`Checking ${peer.name}`);
  const info = await probeRemote(peer);
  spin.update(`Building twin for ${info.arch}`);
  const binary = await buildBinary(info.arch);
  spin.update(`Copying twin to ${peer.name}`);
  await sh(
    peer,
    'mkdir -p "$HOME/.twin/build" "$HOME/.twin/skill" "$HOME/.local/bin"',
  );
  await transfer(peer, {
    from: "local",
    path: fromHome(binary),
    dir: false,
    force: true,
  });
  await shOk(
    peer,
    `cp "$HOME"/${JSON.stringify(fromHome(binary))} "$HOME/.local/bin/twin.twin" && chmod +x "$HOME/.local/bin/twin.twin" && mv "$HOME/.local/bin/twin.twin" "$HOME/.local/bin/twin"`,
  );
  const skill = skillText();
  if (skill)
    await shOk(peer, 'cat > "$HOME/.twin/skill/SKILL.md"', { input: skill });
  const check = await sh(peer, "twin --version");
  spin.stop();
  const version = check.stdout.match(VERSION_RE)?.[0];
  if (!version) {
    throw new TwinError(
      "install_failed",
      `twin was copied but does not run on ${peer.name}: ${check.stderr.trim()}`,
    );
  }
  const onPath = await ensurePath(peer);
  emit({
    ok: true,
    peer: peer.name,
    version,
    path: "~/.local/bin/twin",
    onPath,
  });
  ui.gap();
  ui.ok(
    `twin ${version} installed on ${pc.bold(peer.name)} at ~/.local/bin/twin`,
  );
  if (onPath === "added") ui.ok("Added ~/.local/bin to its PATH in ~/.zshrc");
  ui.hint(`Try it: ${pc.bold(`ssh ${peer.name} twin doctor`)}`);
  ui.gap();
}
