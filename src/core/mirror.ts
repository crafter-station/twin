import { spawn } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Peer } from "./config.ts";
import { TwinError } from "./errors.ts";
import {
  pathMap,
  toLocalRel,
  toLocalText,
  toRemoteRel,
  toRemoteText,
  translateBytes,
} from "./pathmap.ts";
import { HOME, PATHS, TWIN_DIR } from "./paths.ts";
import { sh, shOk, sshOptions, target } from "./ssh.ts";

export type Root = { path: string; translate?: boolean; excludes?: string[] };

type Entry = { mtime: number; size: number; link: boolean };

type Move = {
  local: string;
  remote: string;
  size: number;
  link: boolean;
  translate: boolean;
  replaces: boolean;
};

export type MirrorOptions = {
  push: boolean;
  pull: boolean;
  dryRun: boolean;
  force?: boolean;
  tag: string;
};

const SKIP = new Set([".DS_Store"]);
const BATCH_BYTES = 256 * 1024 * 1024;

const skipped = (name: string, excludes: string[]) =>
  SKIP.has(name) || name.endsWith(".twin") || excludes.includes(name);

function walkLocal(root: Root, into: Map<string, Entry>) {
  const excludes = root.excludes ?? [];
  const visit = (rel: string) => {
    const abs = join(HOME, rel);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(abs);
    } catch {
      return;
    }
    if (stat.isSymbolicLink() || stat.isFile()) {
      into.set(rel, {
        mtime: Math.floor(stat.mtimeMs / 1000),
        size: stat.size,
        link: stat.isSymbolicLink(),
      });
      return;
    }
    if (!stat.isDirectory()) return;
    for (const name of readdirSync(abs)) {
      if (!skipped(name, excludes)) visit(`${rel}/${name}`);
    }
  };
  visit(root.path);
}

async function walkRemote(
  peer: Peer,
  roots: string[],
): Promise<Map<string, Entry>> {
  const list = roots.map((r) => `'${r.replaceAll("'", `'\\''`)}'`).join(" ");
  const { stdout, code, stderr } = await sh(
    peer,
    `cd "$HOME" || exit 1; for r in ${list}; do [ -e "$r" ] || [ -L "$r" ] || continue; find "$r" -type f -exec stat -f 'F %m %z %N' {} +; find "$r" -type l -exec stat -f 'L %m %z %N' {} +; done; true`,
    { timeoutMs: 120_000 },
  );
  if (code !== 0)
    throw new TwinError(
      "remote_failed",
      `Could not list files on ${peer.name}: ${stderr.trim()}`,
    );
  const entries = new Map<string, Entry>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^([FL]) (\d+) (\d+) (.+)$/);
    if (!match) continue;
    const rel = match[4] ?? "";
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    if (skipped(name, [])) continue;
    entries.set(rel, {
      mtime: Number(match[2]),
      size: Number(match[3]),
      link: match[1] === "L",
    });
  }
  return entries;
}

function batches(moves: Move[]): Move[][] {
  const out: Move[][] = [];
  let current: Move[] = [];
  let bytes = 0;
  for (const move of moves) {
    if (current.length > 0 && bytes + move.size > BATCH_BYTES) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(move);
    bytes += move.size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

function place(
  from: string,
  to: string,
  mtime: number,
  link: boolean,
  swap: ((t: string) => string) | undefined,
) {
  mkdirSync(dirname(to), { recursive: true });
  if (link) {
    const target = readlinkSync(from);
    if (lstatSafe(to)) unlinkSync(to);
    symlinkSync(swap ? swap(target) : target, to);
    lutimesSync(to, mtime, mtime);
    return;
  }
  const data = readFileSync(from);
  const tmp = `${to}.${process.pid}.twin`;
  writeFileSync(tmp, swap ? translateBytes(data, swap) : data);
  utimesSync(tmp, mtime, mtime);
  renameSync(tmp, to);
}

function lstatSafe(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function pipe(
  left: [string, string[]],
  right: [string, string[]],
  input?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const a = spawn(left[0], left[1], { stdio: ["pipe", "pipe", "pipe"] });
    const b = spawn(right[0], right[1], { stdio: ["pipe", "ignore", "pipe"] });
    let errors = "";
    a.stderr.on("data", (d) => {
      errors += d;
    });
    b.stderr.on("data", (d) => {
      errors += d;
    });
    a.stdout.pipe(b.stdin);
    a.stdin.end(input);
    let pending = 2;
    let failed = false;
    const done = (code: number | null) => {
      if (code !== 0) failed = true;
      if (--pending > 0) return;
      if (failed)
        reject(
          new TwinError(
            "transfer_failed",
            `Transfer failed: ${errors.trim().split("\n").slice(-3).join(" ")}`,
          ),
        );
      else resolve();
    };
    a.on("close", done);
    b.on("close", done);
  });
}

async function send(
  peer: Peer,
  moves: Move[],
  tag: string,
  mtimes: Map<string, number>,
) {
  const m = pathMap(peer);
  const swap = (t: string) => toRemoteText(m, t);
  mkdirSync(TWIN_DIR, { recursive: true });
  for (const batch of batches(moves)) {
    const stage = mkdtempSync(join(TWIN_DIR, "stage-"));
    try {
      for (const move of batch) {
        place(
          join(HOME, move.local),
          join(stage, move.remote),
          mtimes.get(move.local) ?? 0,
          move.link,
          move.translate ? swap : undefined,
        );
      }
      const replaced = batch.filter((b) => b.replaces).map((b) => b.remote);
      if (replaced.length > 0) {
        await shOk(
          peer,
          `cd "$HOME" && b="$HOME/.twin/backups/${tag}" && while IFS= read -r p; do [ -f "$p" ] || continue; mkdir -p "$b/$(dirname "$p")" && cp -p "$p" "$b/$p"; done`,
          { input: `${replaced.join("\n")}\n` },
        );
      }
      writeFileSync(
        join(stage, ".twin-list"),
        `${batch.map((b) => b.remote).join("\n")}\n`,
      );
      await pipe(
        ["tar", ["-C", stage, "-cf", "-", "-T", join(stage, ".twin-list")]],
        [
          "ssh",
          [
            ...sshOptions(peer.port),
            await target(peer),
            `/bin/sh -c 'cd "$HOME" && tar -xpf -'`,
          ],
        ],
      );
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
}

async function receive(
  peer: Peer,
  moves: Move[],
  tag: string,
  mtimes: Map<string, number>,
) {
  const m = pathMap(peer);
  const swap = (t: string) => toLocalText(m, t);
  mkdirSync(TWIN_DIR, { recursive: true });
  for (const batch of batches(moves)) {
    const stage = mkdtempSync(join(TWIN_DIR, "stage-"));
    try {
      await pipe(
        [
          "ssh",
          [
            ...sshOptions(peer.port),
            await target(peer),
            `/bin/sh -c 'cd "$HOME" && tar -cf - -T -'`,
          ],
        ],
        ["tar", ["-C", stage, "-xpf", "-"]],
        `${batch.map((b) => b.remote).join("\n")}\n`,
      );
      for (const move of batch) {
        const dest = join(HOME, move.local);
        const current = lstatSafe(dest);
        if (current?.isFile()) {
          const backup = join(PATHS.backups, tag, move.local);
          mkdirSync(dirname(backup), { recursive: true });
          copyFileSync(dest, backup);
        }
        place(
          join(stage, move.remote),
          dest,
          mtimes.get(move.remote) ?? 0,
          move.link,
          move.translate ? swap : undefined,
        );
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
}

export async function mirror(peer: Peer, roots: Root[], opts: MirrorOptions) {
  const m = pathMap(peer);
  const local = new Map<string, Entry>();
  for (const root of roots) walkLocal(root, local);
  const remote = await walkRemote(
    peer,
    roots.map((r) => toRemoteRel(m, r.path)),
  );

  const rootOf = (rel: string) =>
    roots.find((r) => rel === r.path || rel.startsWith(`${r.path}/`));
  const translates = (rel: string) => rootOf(rel)?.translate !== false;
  const excluded = (rel: string) => {
    const root = rootOf(rel);
    return (
      !root || (root.excludes ?? []).some((e) => rel.split("/").includes(e))
    );
  };

  const up: Move[] = [];
  const down: Move[] = [];
  const localTimes = new Map<string, number>();
  const remoteTimes = new Map<string, number>();

  if (opts.push) {
    for (const [rel, entry] of local) {
      const rrel = toRemoteRel(m, rel);
      const there = remote.get(rrel);
      const send =
        !there ||
        (opts.force ? entry.mtime !== there.mtime : entry.mtime > there.mtime);
      if (!send) continue;
      up.push({
        local: rel,
        remote: rrel,
        size: entry.size,
        link: entry.link,
        translate: translates(rel),
        replaces: Boolean(there),
      });
      localTimes.set(rel, entry.mtime);
    }
  }
  if (opts.pull) {
    for (const [rrel, entry] of remote) {
      const rel = toLocalRel(m, rrel);
      if (excluded(rel)) continue;
      const here = local.get(rel);
      const take =
        !here ||
        (opts.force && !opts.push
          ? entry.mtime !== here.mtime
          : entry.mtime > here.mtime);
      if (!take) continue;
      down.push({
        local: rel,
        remote: rrel,
        size: entry.size,
        link: entry.link,
        translate: translates(rel),
        replaces: Boolean(here),
      });
      remoteTimes.set(rrel, entry.mtime);
    }
  }

  if (!opts.dryRun) {
    if (up.length > 0) await send(peer, up, opts.tag, localTimes);
    if (down.length > 0) await receive(peer, down, opts.tag, remoteTimes);
  }

  const strip = (rel: string) => {
    const root = rootOf(rel);
    return root && rel !== root.path
      ? rel.slice(root.path.length + 1)
      : rel.slice(rel.lastIndexOf("/") + 1);
  };
  return {
    up: up.map((u) => strip(u.local)),
    down: down.map((d) => strip(d.local)),
  };
}
