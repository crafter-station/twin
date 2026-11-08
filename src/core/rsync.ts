import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Peer } from "./config.ts";
import { TwinError } from "./errors.ts";
import { HOME } from "./paths.ts";
import { run } from "./proc.ts";
import { sshOptions, target } from "./ssh.ts";

export type Side = "local" | "remote";

export type Transfer = {
  from: Side;
  path: string;
  dir: boolean;
  excludes?: string[];
  dryRun?: boolean;
  backupTag?: string;
  force?: boolean;
};

const ALWAYS_EXCLUDE = [".DS_Store", "*.twin"];
const VANISHED = 24;

const escapeRemote = (path: string) => path.replace(/([\s'"\\$`])/g, "\\$1");

function parseItemized(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => /^[<>c][fL]/.test(line) && !/^..\.+ /.test(line))
    .map((line) => line.slice(line.indexOf(" ") + 1));
}

export async function transfer(peer: Peer, t: Transfer): Promise<string[]> {
  const slash = t.dir ? "/" : "";
  const localPath = join(HOME, t.path);
  const local = `${localPath}${slash}`;
  const remote = `${await target(peer)}:${escapeRemote(t.path)}${slash}`;
  const [src, dst] = t.from === "local" ? [local, remote] : [remote, local];

  if (t.from === "remote" && !t.dryRun) {
    mkdirSync(t.dir ? localPath : dirname(localPath), { recursive: true });
  }

  const args = [
    "-a",
    "-i",
    ...(t.force ? [] : ["-u"]),
    "-e",
    ["ssh", ...sshOptions(peer.port)].join(" "),
    ...[...ALWAYS_EXCLUDE, ...(t.excludes ?? [])].map((e) => `--exclude=${e}`),
  ];

  if (t.dryRun) {
    args.push("-n");
  } else if (t.backupTag) {
    const base = t.from === "local" ? peer.home : HOME;
    const dir = join(base, ".twin", "backups", t.backupTag, t.path);
    args.push("-b", `--backup-dir=${t.dir ? dir : dirname(dir)}`);
  }

  const result = await run("rsync", [...args, src, dst], {
    timeoutMs: 60 * 60 * 1000,
  });
  if (result.code !== 0 && result.code !== VANISHED) {
    throw new TwinError(
      "rsync_failed",
      `Copying ${t.path} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
  return parseItemized(result.stdout);
}
