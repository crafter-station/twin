import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type LinkedProject, loadConfig, type Peer } from "./config.ts";
import { TwinError } from "./errors.ts";
import { type Move, receive, send } from "./mirror.ts";
import { HOME, PATHS, projectKey } from "./paths.ts";
import { run } from "./proc.ts";
import { PROJECT_EXCLUDES } from "./scopes.ts";
import { sh, shOk, shq } from "./ssh.ts";
import { readJson, writeJson } from "./store.ts";

type Entry = { mtime: number; size: number; link: boolean };
type Packed = [number, number, 0 | 1];
type Base = Record<string, Packed>;
type Files = Map<string, Entry>;

export type ProjectReport = {
  path: string;
  up: string[];
  down: string[];
  deleted: { here: string[]; there: string[] };
  conflicts: string[];
  kept: string[];
  missing?: "here" | "there" | "both";
};

export type ProjectOptions = {
  push: boolean;
  pull: boolean;
  dryRun: boolean;
  force?: boolean;
  tag: string;
};

type Plan = {
  up: string[];
  down: string[];
  dropHere: string[];
  dropThere: string[];
  conflicts: { path: string; loser: "here" | "there" }[];
  next: Base;
};

const BRANCH_REF = /^(.*\/)?\.git\/refs\/heads\/(.+)$/;

export const linkedProjects = (): LinkedProject[] =>
  loadConfig().projects ?? [];

export const excludesOf = (project: LinkedProject) =>
  project.excludes ?? PROJECT_EXCLUDES;

const basePath = (peer: Peer, project: LinkedProject) =>
  join(PATHS.projects, peer.name, `${projectKey(project.path)}.json`);

export function forgetProject(project: LinkedProject) {
  if (!existsSync(PATHS.projects)) return;
  for (const peer of readdirSync(PATHS.projects)) {
    rmSync(join(PATHS.projects, peer, `${projectKey(project.path)}.json`), {
      force: true,
    });
  }
}

function skipper(excludes: string[]) {
  const names = new Set([
    ".DS_Store",
    ...excludes.filter((e) => !e.includes("/")),
  ]);
  const paths = excludes.filter((e) => e.includes("/"));
  return (rel: string) => {
    const parts = rel.split("/");
    const name = parts[parts.length - 1] ?? "";
    if (name.endsWith(".twin")) return true;
    if (parts.some((p) => names.has(p))) return true;
    if (paths.some((p) => `/${rel}/`.includes(`/${p}/`))) return true;
    const git = parts.indexOf(".git");
    if (git === -1) return false;
    return parts[git + 1] === "worktrees" || name.endsWith(".lock");
  };
}

function walkHere(root: string, skip: (rel: string) => boolean) {
  const abs = join(HOME, root);
  if (!existsSync(abs)) return undefined;
  const files: Files = new Map();
  const visit = (rel: string) => {
    let items: ReturnType<typeof readDir>;
    try {
      items = readDir(join(abs, rel));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new TwinError(
        "walk_failed",
        `Could not read ${join(root, rel)}: ${(error as Error).message}`,
      );
    }
    for (const item of items) {
      const next = rel ? `${rel}/${item.name}` : item.name;
      if (skip(next)) continue;
      if (item.isDirectory()) {
        visit(next);
        continue;
      }
      if (!item.isFile() && !item.isSymbolicLink()) continue;
      try {
        const stat = lstatSync(join(abs, next));
        files.set(next, {
          mtime: Math.floor(stat.mtimeMs / 1000),
          size: stat.size,
          link: stat.isSymbolicLink(),
        });
      } catch {}
    }
  };
  visit("");
  return files;
}

const readDir = (path: string) => readdirSync(path, { withFileTypes: true });

async function walkThere(
  peer: Peer,
  project: LinkedProject,
  skip: (rel: string) => boolean,
) {
  const excludes = excludesOf(project);
  const prune = [
    "-name .DS_Store",
    ...excludes.map((e) =>
      e.includes("/") ? `-path ${shq(`*/${e}`)}` : `-name ${shq(e)}`,
    ),
    `-path ${shq("*/.git/worktrees")}`,
  ].join(" -o ");
  const { stdout, stderr } = await sh(
    peer,
    `cd "$HOME" || exit 1; [ -d ${shq(project.path)} ] || { echo MISSING; exit 0; }; cd ${shq(project.path)} || exit 1; find . \\( ${prune} \\) -prune -o -type f -exec stat -f 'F %m %z %N' {} + -o -type l -exec stat -f 'L %m %z %N' {} +; echo DONE`,
    { timeoutMs: 600_000 },
  );
  const lines = stdout.split("\n");
  if (lines.includes("MISSING")) return undefined;
  const trouble = stderr
    .split("\n")
    .filter((l) => l.trim() && !l.includes("No such file or directory"));
  if (!lines.includes("DONE") || trouble.length > 0) {
    throw new TwinError(
      "walk_failed",
      `Could not list ${project.path} on ${peer.name}: ${trouble[0] ?? "the listing was cut short"}`,
    );
  }
  const files: Files = new Map();
  for (const line of lines) {
    const match = line.match(/^([FL]) (\d+) (\d+) \.\/(.+)$/);
    if (!match) continue;
    const rel = match[4] ?? "";
    if (skip(rel)) continue;
    files.set(rel, {
      mtime: Number(match[2]),
      size: Number(match[3]),
      link: match[1] === "L",
    });
  }
  return files;
}

const pack = (e: Entry): Packed => [e.mtime, e.size, e.link ? 1 : 0];

const unpack = (p?: Packed): Entry | undefined =>
  p ? { mtime: p[0], size: p[1], link: p[2] === 1 } : undefined;

const same = (a: Entry, b: Entry) =>
  a.link === b.link && a.size === b.size && (a.link || a.mtime === b.mtime);

function plan(here: Files, there: Files, base: Base, opts: ProjectOptions) {
  const out: Plan = {
    up: [],
    down: [],
    dropHere: [],
    dropThere: [],
    conflicts: [],
    next: {},
  };
  const forceUp = Boolean(opts.force && opts.push && !opts.pull);
  const forceDown = Boolean(opts.force && opts.pull && !opts.push);
  const paths = new Set([
    ...here.keys(),
    ...there.keys(),
    ...Object.keys(base),
  ]);

  for (const path of paths) {
    const l = here.get(path);
    const r = there.get(path);
    const b = unpack(base[path]);
    const keep = () => {
      const old = base[path];
      if (old) out.next[path] = old;
    };
    const goUp = (entry: Entry) => {
      if (!opts.push) return keep();
      out.up.push(path);
      out.next[path] = pack(entry);
    };
    const goDown = (entry: Entry) => {
      if (!opts.pull) return keep();
      out.down.push(path);
      out.next[path] = pack(entry);
    };

    if (l && r) {
      if (same(l, r)) {
        out.next[path] = pack(l);
        continue;
      }
      const onlyThere = b && same(l, b);
      const onlyHere = b && same(r, b);
      const clash = Boolean(b) && !onlyThere && !onlyHere;
      const hereWins = forceUp
        ? true
        : forceDown
          ? false
          : onlyThere
            ? false
            : onlyHere
              ? true
              : l.mtime >= r.mtime;
      if (hereWins) goUp(l);
      else goDown(r);
      if (clash && (hereWins ? opts.push : opts.pull)) {
        out.conflicts.push({ path, loser: hereWins ? "there" : "here" });
      }
      continue;
    }
    if (l) {
      if (b && same(l, b) && !forceUp) {
        if (opts.pull) out.dropHere.push(path);
        else keep();
      } else goUp(l);
      continue;
    }
    if (r) {
      if (b && same(r, b) && !forceDown) {
        if (opts.push) out.dropThere.push(path);
        else keep();
      } else goDown(r);
    }
  }
  return out;
}

function dropHere(root: string, paths: string[], tag: string) {
  const top = join(HOME, root);
  for (const path of paths) {
    const from = join(top, path);
    const to = join(PATHS.backups, tag, root, path);
    mkdirSync(dirname(to), { recursive: true });
    try {
      renameSync(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code !== "EXDEV") throw error;
      copyFileSync(from, to);
      unlinkSync(from);
    }
    let dir = dirname(from);
    while (dir !== top && dir.startsWith(top)) {
      try {
        rmdirSync(dir);
      } catch {
        break;
      }
      dir = dirname(dir);
    }
  }
}

async function dropThere(
  peer: Peer,
  root: string,
  paths: string[],
  tag: string,
) {
  await shOk(
    peer,
    `cd "$HOME"/${shq(root)} || exit 1; b="$HOME/.twin/backups/${tag}/"${shq(root)}; while IFS= read -r p; do [ -e "$p" ] || [ -L "$p" ] || continue; case "$p" in */*) d="\${p%/*}";; *) d=.;; esac; mkdir -p "$b/$d" && mv "$p" "$b/$p" || exit 1; while [ "$d" != . ] && rmdir "$d" 2>/dev/null; do case "$d" in */*) d="\${d%/*}";; *) d=.;; esac; done; done`,
    { input: `${paths.join("\n")}\n`, timeoutMs: 600_000 },
  );
}

async function losingTips(
  peer: Peer,
  root: string,
  conflicts: Plan["conflicts"],
) {
  const refs = conflicts.filter((c) => BRANCH_REF.test(c.path));
  const tips = new Map<string, string>();
  for (const ref of refs.filter((c) => c.loser === "here")) {
    try {
      tips.set(
        ref.path,
        readFileSync(join(HOME, root, ref.path), "utf8").trim(),
      );
    } catch {}
  }
  const remote = refs.filter((c) => c.loser === "there").map((c) => c.path);
  if (remote.length > 0) {
    const { stdout } = await sh(
      peer,
      `cd "$HOME"/${shq(root)} || exit 0; while IFS= read -r p; do printf '%s %s\\n' "$(cat "$p" 2>/dev/null)" "$p"; done`,
      { input: `${remote.join("\n")}\n` },
    );
    for (const line of stdout.split("\n")) {
      const space = line.indexOf(" ");
      if (space > 0) tips.set(line.slice(space + 1), line.slice(0, space));
    }
  }
  return tips;
}

async function keepTips(
  peer: Peer,
  root: string,
  tips: Map<string, string>,
  tag: string,
) {
  const kept: string[] = [];
  const repos = new Set<string>();
  for (const [path, sha] of tips) {
    const match = path.match(BRANCH_REF);
    if (!match || !/^[0-9a-f]{40,64}$/.test(sha)) continue;
    const repo = join(HOME, root, match[1] ?? "");
    const ref = `refs/twin/kept/${tag}/${match[2]}`;
    const made = await run("git", ["-C", repo, "update-ref", ref, sha]);
    if (made.code !== 0) continue;
    kept.push(`${match[1] ?? ""}${ref}`);
    repos.add(match[1] ?? "");
  }
  for (const prefix of repos) {
    const repo = join(root, prefix);
    await run("git", ["-C", join(HOME, repo), "reset", "-q"]);
    await sh(peer, `cd "$HOME"/${shq(repo)} && git reset -q`);
  }
  return kept;
}

async function syncProject(
  peer: Peer,
  project: LinkedProject,
  opts: ProjectOptions,
): Promise<ProjectReport> {
  const root = project.path;
  const skip = skipper(excludesOf(project));
  const [here, there] = await Promise.all([
    Promise.resolve().then(() => walkHere(root, skip)),
    walkThere(peer, project, skip),
  ]);
  const report: ProjectReport = {
    path: root,
    up: [],
    down: [],
    deleted: { here: [], there: [] },
    conflicts: [],
    kept: [],
  };
  if (!here && !there) return { ...report, missing: "both" };
  if (!here) report.missing = "here";
  if (!there) report.missing = "there";

  const local: Files = here ?? new Map();
  const remote: Files = there ?? new Map();
  const empty = local.size === 0 || remote.size === 0;
  const saved = readJson<{ files: Base }>(basePath(peer, project), {
    files: {},
  });
  const todo = plan(local, remote, empty ? {} : saved.files, opts);

  report.up = todo.up;
  report.down = todo.down;
  report.deleted = { here: todo.dropHere, there: todo.dropThere };
  report.conflicts = todo.conflicts
    .map((c) => c.path)
    .filter((p) => !p.split("/").includes(".git"));
  if (opts.dryRun) return report;

  const tips = await losingTips(peer, root, todo.conflicts);
  const move = (path: string, entry: Entry, replaces: boolean): Move => ({
    local: `${root}/${path}`,
    remote: `${root}/${path}`,
    size: entry.size,
    link: entry.link,
    translate: false,
    replaces,
  });
  const times = (paths: string[], files: Files) =>
    new Map(paths.map((p) => [`${root}/${p}`, files.get(p)?.mtime ?? 0]));

  if (todo.up.length > 0) {
    await send(
      peer,
      todo.up.map((p) => move(p, local.get(p) as Entry, remote.has(p))),
      opts.tag,
      times(todo.up, local),
    );
  }
  if (todo.down.length > 0) {
    await receive(
      peer,
      todo.down.map((p) => move(p, remote.get(p) as Entry, local.has(p))),
      opts.tag,
      times(todo.down, remote),
    );
  }
  if (todo.dropThere.length > 0) {
    await dropThere(peer, root, todo.dropThere, opts.tag);
  }
  if (todo.dropHere.length > 0) dropHere(root, todo.dropHere, opts.tag);
  if (tips.size > 0) report.kept = await keepTips(peer, root, tips, opts.tag);

  writeJson(basePath(peer, project), { files: todo.next });
  return report;
}

export async function syncProjects(peer: Peer, opts: ProjectOptions) {
  const reports: ProjectReport[] = [];
  for (const project of linkedProjects()) {
    reports.push(await syncProject(peer, project, opts));
  }
  return reports;
}
