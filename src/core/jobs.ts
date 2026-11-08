import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Peer } from "./config.ts";
import { TwinError } from "./errors.ts";
import { mirror } from "./mirror.ts";
import {
  CLAUDE_DIR,
  fromHome,
  HOME,
  isInsideHome,
  projectKey,
  stamp,
} from "./paths.ts";
import { localName } from "./proc.ts";
import { transfer } from "./rsync.ts";
import { PROJECT_EXCLUDES } from "./scopes.ts";
import { sh, shLines, shOk, shq } from "./ssh.ts";
import { loadState, updateState } from "./state.ts";

export type Mode =
  | "auto"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk";

export type JobMeta = {
  id: string;
  sessionId: string;
  name: string;
  dir: string;
  prompt: string;
  peer: string;
  from: string;
  mode: Mode;
  model?: string;
  startedAt: string;
};

export type JobStatus = "running" | "done" | "failed" | "stopped" | "crashed";

export type Job = JobMeta & {
  status: JobStatus;
  result?: string;
  costUsd?: number;
  durationMs?: number;
  turns?: number;
  error?: string;
};

export type ResultEvent = {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
};

const JOBS = "$HOME/.twin/jobs";

const newId = () =>
  `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`;

const slug = (prompt: string) =>
  prompt.replace(/\s+/g, " ").trim().slice(0, 48);

const systemPrompt = (peer: string, from: string) =>
  [
    `You are running headless on ${peer}, a Mac that ${from} delegated this task to through twin.`,
    "Nobody is watching live, so do not ask questions. Make sensible decisions and keep going.",
    "Regenerable folders like node_modules are not copied over, so install dependencies when you need them.",
    "Never spend real money, send messages, publish, or deploy to production unless the task explicitly says so.",
    "When you finish, reply with a short summary of what changed and anything left to do.",
  ].join(" ");

function assertProjectDir(dir: string, force: boolean) {
  if (!isInsideHome(dir)) {
    throw new TwinError(
      "bad_dir",
      `${dir} is outside your home folder, so it cannot map to the same path on the other Mac.`,
    );
  }
  if (force || existsSync(join(dir, ".git"))) return;
  const repos = readdirSync(dir, { withFileTypes: true }).filter(
    (d) => d.isDirectory() && existsSync(join(dir, d.name, ".git")),
  ).length;
  if (repos >= 3) {
    throw new TwinError(
      "folder_of_projects",
      `${dir} holds ${repos} projects, so copying it would be huge.`,
      "cd into one project, pass --dir, or add --force.",
    );
  }
}

export async function startJob(
  peer: Peer,
  input: {
    prompt: string;
    dir: string;
    mode: Mode;
    model?: string;
    copy: boolean;
    force: boolean;
  },
): Promise<{ job: JobMeta; copied: number }> {
  assertProjectDir(input.dir, input.force);
  let copied = 0;
  if (input.copy) {
    await sh(peer, `mkdir -p "$HOME"/${shq(fromHome(input.dir))}`);
    copied = (
      await transfer(peer, {
        from: "local",
        path: fromHome(input.dir),
        dir: true,
        excludes: PROJECT_EXCLUDES,
      })
    ).length;
    const memory = join(
      CLAUDE_DIR,
      "projects",
      projectKey(input.dir),
      "memory",
    );
    if (existsSync(memory)) {
      await mirror(peer, [{ path: fromHome(memory) }], {
        push: true,
        pull: false,
        dryRun: false,
        tag: stamp(),
      });
    }
  }

  const from = await localName();
  const job: JobMeta = {
    id: newId(),
    sessionId: randomUUID(),
    name: `twin: ${slug(input.prompt)}`,
    dir: input.dir,
    prompt: input.prompt,
    peer: peer.name,
    from,
    mode: input.mode,
    model: input.model,
    startedAt: new Date().toISOString(),
  };

  const claude = [
    "claude",
    "-p",
    shq(input.prompt),
    "--session-id",
    job.sessionId,
    "-n",
    shq(job.name),
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    job.mode,
    "--append-system-prompt",
    shq(systemPrompt(peer.name, from)),
    ...(job.model ? ["--model", shq(job.model)] : []),
  ].join(" ");

  const base = `${JOBS}/${job.id}`;
  await shOk(
    peer,
    `mkdir -p ${JOBS} && cat > "${base}.json" && cd "$HOME"/${shq(fromHome(job.dir))} && { nohup caffeinate -i ${claude} > "${base}.jsonl" 2> "${base}.err" < /dev/null & echo $! > "${base}.pid"; }`,
    { input: JSON.stringify(job) },
  );
  updateState((state) => {
    state.lastJob = { peer: peer.name, id: job.id };
  });
  return { job, copied };
}

function parseResult(line: string): ResultEvent | undefined {
  try {
    const event = JSON.parse(line) as { type?: string };
    return event.type === "result" ? (event as ResultEvent) : undefined;
  } catch {
    return undefined;
  }
}

export function describe(
  meta: JobMeta,
  alive: boolean,
  last: string,
  err: string,
  stopped: boolean,
): Job {
  const result = parseResult(last);
  if (result) {
    return {
      ...meta,
      status: result.is_error ? "failed" : "done",
      result: result.result,
      costUsd: result.total_cost_usd,
      durationMs: result.duration_ms,
      turns: result.num_turns,
    };
  }
  if (alive) return { ...meta, status: "running" };
  if (stopped) return { ...meta, status: "stopped" };
  return {
    ...meta,
    status: "crashed",
    error: err.trim() || "Exited without a result.",
  };
}

export async function listJobs(peer: Peer): Promise<Job[]> {
  const { stdout } = await sh(
    peer,
    `cd ${JOBS} 2>/dev/null || exit 0
for m in *.json; do
  [ -f "$m" ] || continue
  id="\${m%.json}"
  pid=$(cat "$id.pid" 2>/dev/null)
  alive=0; [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && alive=1
  stopped=0; [ -f "$id.stopped" ] && stopped=1
  printf 'J\\t%s\\t%s\\n' "$alive" "$stopped"
  printf 'M\\t'; tr -d '\\n' < "$m"; echo
  printf 'R\\t'; tail -n 1 "$id.jsonl" 2>/dev/null | tr -d '\\n'; echo
  printf 'E\\t'; tail -c 400 "$id.err" 2>/dev/null | tr '\\n\\t' '  '; echo
done`,
  );
  const rows = stdout.split("\n");
  const jobs: Job[] = [];
  for (let i = 0; i + 3 < rows.length; i += 4) {
    const [, alive, stopped] = (rows[i] ?? "").split("\t");
    const field = (n: number) => (rows[i + n] ?? "").slice(2);
    try {
      const meta = JSON.parse(field(1)) as JobMeta;
      jobs.push(
        describe(meta, alive === "1", field(2), field(3), stopped === "1"),
      );
    } catch {}
  }
  return jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function findJob(peer: Peer, ref?: string): Promise<Job> {
  const wanted = ref ?? loadState().lastJob?.id;
  if (!wanted) {
    throw new TwinError(
      "no_job",
      "No job yet.",
      'Start one with `twin run "<task>"`.',
    );
  }
  const jobs = await listJobs(peer);
  const matches = jobs.filter((j) => j.id.startsWith(wanted));
  const job = wanted === "last" ? jobs[0] : matches[0];
  if (!job || matches.length > 1) {
    throw new TwinError(
      "unknown_job",
      matches.length > 1
        ? `"${wanted}" matches ${matches.length} jobs.`
        : `No job "${wanted}" on ${peer.name}.`,
      "See them with `twin jobs`.",
    );
  }
  return job;
}

export function followJob(
  peer: Peer,
  job: JobMeta,
  onEvent: (line: string) => void,
  follow: boolean,
): Promise<number> {
  const base = `${JOBS}/${job.id}`;
  const script = follow
    ? `p=$(cat "${base}.pid" 2>/dev/null); tail -n +1 -f "${base}.jsonl" & t=$!; while kill -0 "$p" 2>/dev/null; do sleep 1; done; sleep 1; kill $t 2>/dev/null; true`
    : `cat "${base}.jsonl" 2>/dev/null; true`;
  return shLines(peer, script, (line) => {
    onEvent(line);
    return parseResult(line) !== undefined;
  });
}

export async function stopJob(peer: Peer, job: JobMeta) {
  const base = `${JOBS}/${job.id}`;
  await sh(
    peer,
    `p=$(cat "${base}.pid" 2>/dev/null); [ -n "$p" ] && { pkill -TERM -P "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null; }; touch "${base}.stopped"; true`,
  );
}

export async function fetchJob(peer: Peer, job: JobMeta) {
  const changed = await transfer(peer, {
    from: "remote",
    path: fromHome(job.dir),
    dir: true,
    excludes: PROJECT_EXCLUDES,
  });
  await pullSessions(peer, job.dir);
  return {
    changed: changed.filter((f) => !f.startsWith(".git/")),
    dir: job.dir,
    home: HOME,
  };
}

export function pullSessions(peer: Peer, dir: string) {
  return mirror(
    peer,
    [{ path: fromHome(join(CLAUDE_DIR, "projects", projectKey(dir))) }],
    { push: false, pull: true, dryRun: false, tag: stamp() },
  );
}
