import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import { loadConfig, type Peer, saveConfig } from "../core/config.ts";
import { TwinError } from "../core/errors.ts";
import { probe, routeKind } from "../core/net.ts";
import { HOME, PATHS } from "../core/paths.ts";
import { probeRemote } from "../core/probe.ts";
import { interactive, localName, run } from "../core/proc.ts";
import { sshOptions } from "../core/ssh.ts";
import { writeText } from "../core/store.ts";
import { emit, say, spinner, ui } from "../ui/out.ts";

type Found = { host: string; address: string; iface: string; ssh: boolean };

async function discover(): Promise<Found[]> {
  const self = (await localName()).toLowerCase();
  const { stdout } = await run("arp", ["-a"], { timeoutMs: 3000 });
  const seen = stdout
    .split("\n")
    .map((l) => l.match(/^(\S+\.local) \(([\d.]+)\) at \S+ on (\S+)/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ host: m[1] ?? "", address: m[2] ?? "", iface: m[3] ?? "" }))
    .filter((f) => !f.host.toLowerCase().startsWith(self));
  const found = await Promise.all(
    seen.map(async (f) => ({ ...f, ssh: (await probe(f.address)) !== null })),
  );
  return found.sort(
    (a, b) =>
      Number(b.ssh) - Number(a.ssh) ||
      Number(routeKind(b.address) === "usb-c") -
        Number(routeKind(a.address) === "usb-c"),
  );
}

const canLogin = async (login: string) =>
  (await run("ssh", [...sshOptions(), login, "true"], { timeoutMs: 15_000 }))
    .code === 0;

function nameFor(remoteHost: string) {
  const lower = remoteHost.toLowerCase();
  if (lower.includes("mini")) return "mini";
  if (lower.includes("studio")) return "studio";
  if (lower.includes("pro")) return "pro";
  if (lower.includes("air")) return "air";
  return lower.replace(/[^a-z0-9]+/g, "-");
}

function writeSshAlias(peers: Peer[]) {
  const blocks = peers.map(
    (p) =>
      `Host ${p.name}\n  HostName ${p.host}\n  User ${p.user}\n  ControlMaster auto\n  ControlPath ${PATHS.sockets}/%C\n  ControlPersist 180\n`,
  );
  writeText(PATHS.sshConfig, `${blocks.join("\n")}`);
  const userConfig = join(HOME, ".ssh", "config");
  const include = `Include ${PATHS.sshConfig}`;
  const current = existsSync(userConfig)
    ? readFileSync(userConfig, "utf8")
    : "";
  if (current.includes(include)) return false;
  if (current) copyFileSync(userConfig, `${userConfig}.twin-backup`);
  writeFileSync(userConfig, `${include}\n\n${current}`, { mode: 0o600 });
  return true;
}

export async function pair(
  hostArg: string | undefined,
  opts: { name?: string; user?: string },
) {
  const spin = spinner("Looking for Macs nearby");
  let host = hostArg;
  let address = hostArg;
  if (!host) {
    const found = await discover();
    spin.stop();
    const ready = found.filter((f) => f.ssh);
    const first = ready[0];
    if (!first) {
      const off = found[0];
      throw new TwinError(
        off ? "ssh_off" : "not_found",
        off
          ? `Found ${off.host}, but Remote Login is off on it.`
          : "No other Mac found on the cable or network.",
        off
          ? "On that Mac: System Settings → General → Sharing → Remote Login → On. Then run `twin pair` again."
          : "Connect the Mac with a cable or the same Wi-Fi, or pass its name: `twin pair my-mini.local`.",
      );
    }
    host = first.host;
    address = first.address;
  }
  spin.stop();

  const user = opts.user ?? userInfo().username;
  const login = `${user}@${address}`;

  if (!(await canLogin(login))) {
    if (!process.stdin.isTTY) {
      throw new TwinError(
        "needs_password",
        `${host} needs its password once to trust this Mac.`,
        "Run `! twin pair` in Claude Code, or `twin pair` in a terminal.",
      );
    }
    const key = join(HOME, ".ssh", "id_ed25519.pub");
    if (!existsSync(key)) {
      await interactive("ssh-keygen", [
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        key.replace(/\.pub$/, ""),
      ]);
    }
    say(
      `\n  ${pc.bold(host)} will ask for ${pc.bold(user)}'s password once.\n`,
    );
    await interactive("ssh-copy-id", [
      "-i",
      key,
      "-o",
      "StrictHostKeyChecking=accept-new",
      login,
    ]);
    if (!(await canLogin(login))) {
      throw new TwinError(
        "auth_failed",
        `Could not sign in to ${host} with the SSH key.`,
      );
    }
  }

  const draft: Peer = {
    name: "draft",
    user,
    host: host ?? "",
    hostname: "",
    home: "",
    addresses: address && address !== host ? [address] : [],
    pairedAt: new Date().toISOString(),
  };
  const info = await probeRemote(draft);
  const config = loadConfig();
  const name = opts.name ?? nameFor(info.hostname || host || "mac");
  const peer: Peer = {
    ...draft,
    name,
    host: info.hostname ? `${info.hostname}.local` : draft.host,
    hostname: info.hostname,
    home: info.home,
    arch: info.arch,
    os: info.os,
  };
  config.peers[name] = peer;
  config.defaultPeer ??= name;
  saveConfig(config);
  const addedInclude = writeSshAlias(Object.values(config.peers));

  emit({ ok: true, peer, remote: info });
  ui.head("twin pair", `${name} is ready`);
  ui.ok(
    `${pc.bold(name)} → ${info.hostname} · macOS ${info.os} · ${info.arch}`,
  );
  ui.ok(`Signed in with your SSH key over ${routeKind(address ?? "")}`);
  ui.ok(
    info.home === HOME
      ? `Same home folder (${HOME})`
      : `Paths translated ${HOME} ↔ ${info.home}`,
  );
  ui[info.claude ? "ok" : "info"](
    info.claude
      ? `Claude Code ${info.version}`
      : "Claude Code not installed yet",
  );
  if (addedInclude) ui.ok(`\`ssh ${name}\` now works too`);
  ui.gap();
  ui.hint(`Next: ${pc.bold("twin setup")} makes ${name} match this Mac`);
  ui.gap();
}
