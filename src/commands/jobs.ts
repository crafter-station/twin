import pc from "picocolors";
import { getPeer, type Peer } from "../core/config.ts";
import { TwinError } from "../core/errors.ts";
import {
  fetchJob,
  findJob,
  followJob,
  type Job,
  type JobMeta,
  listJobs,
  type Mode,
  pullSessions,
  startJob,
  stopJob,
} from "../core/jobs.ts";
import { fromHome, isInsideHome } from "../core/paths.ts";
import { transfer } from "../core/rsync.ts";
import { PROJECT_EXCLUDES } from "../core/scopes.ts";
import { shq, shTty } from "../core/ssh.ts";
import {
  ago,
  duration,
  emit,
  isJson,
  money,
  plural,
  spinner,
  ui,
} from "../ui/out.ts";
import { renderEvent } from "../ui/render.ts";

const MODES: Mode[] = [
  "auto",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
];

type RunFlags = {
  on?: string;
  dir?: string;
  mode?: string;
  model?: string;
  copy?: boolean;
  wait?: boolean;
  fetch?: boolean;
  force?: boolean;
};

const STATUS: Record<Job["status"], string> = {
  running: pc.cyan("● running"),
  done: pc.green("✓ done"),
  failed: pc.red("✗ failed"),
  stopped: pc.dim("■ stopped"),
  crashed: pc.red("✗ crashed"),
};

export async function runCommand(words: string[], flags: RunFlags) {
  const prompt = words.join(" ").trim();
  if (!prompt)
    throw new TwinError(
      "no_prompt",
      "Tell the other Mac what to do.",
      'twin run "fix the failing tests"',
    );
  const mode = (flags.mode ?? "auto") as Mode;
  if (!MODES.includes(mode))
    throw new TwinError(
      "bad_mode",
      `Unknown mode "${mode}".`,
      `Use ${MODES.join(", ")}.`,
    );
  const peer = getPeer(flags.on);
  const dir = flags.dir ?? process.cwd();

  const spin = spinner(
    flags.copy === false
      ? `Starting on ${peer.name}`
      : `Copying ${fromHome(dir)} to ${peer.name}`,
  );
  const { job, copied } = await startJob(peer, {
    prompt,
    dir,
    mode,
    model: flags.model,
    copy: flags.copy !== false,
    force: Boolean(flags.force),
  });
  spin.stop();

  if (!flags.wait) {
    emit({ ok: true, job, copied });
    ui.head(`twin run ${pc.cyan(job.id)}`, `${peer.name} · ${fromHome(dir)}`);
    ui.ok(
      `Started on ${pc.bold(peer.name)}${copied ? pc.dim(` · ${plural(copied, "file")} copied`) : ""}`,
    );
    ui.gap();
    ui.hint(`${pc.bold(`twin logs ${job.id} -f`)}   watch it work`);
    ui.hint(`${pc.bold(`twin fetch ${job.id}`)}     bring the changes back`);
    ui.hint(`${pc.bold("twin jobs")}             see everything running`);
    ui.gap();
    return;
  }

  if (!isJson())
    ui.head(`twin run ${pc.cyan(job.id)}`, `${peer.name} · ${fromHome(dir)}`);
  await followJob(peer, job, (line) => renderEvent(line, peer.name), true);
  const done = await findJob(peer, job.id);
  const fetched =
    flags.fetch === false || done.status !== "done"
      ? undefined
      : await fetchJob(peer, job);
  emit({ ok: done.status === "done", job: done, changed: fetched?.changed });
  if (fetched) printFetched(job, fetched.changed);
  else if (done.status !== "done") {
    ui.gap();
    ui.fail(`${STATUS[done.status]} ${done.error ?? done.result ?? ""}`.trim());
    ui.gap();
  }
}

function printFetched(job: JobMeta, changed: string[]) {
  ui.gap();
  ui.ok(
    changed.length
      ? `Brought back ${plural(changed.length, "changed file")}`
      : "No file changes to bring back",
  );
  for (const f of changed.slice(0, 15)) ui.info(f);
  if (changed.length > 15) ui.info(pc.dim(`and ${changed.length - 15} more`));
  ui.hint(`Continue here: ${pc.bold(`claude --resume ${job.sessionId}`)}`);
  ui.gap();
}

export async function jobsCommand(flags: { on?: string; all?: boolean }) {
  const peer = getPeer(flags.on);
  const spin = spinner(`Reading jobs on ${peer.name}`);
  const jobs = await listJobs(peer);
  spin.stop();
  const shown = flags.all ? jobs : jobs.slice(0, 12);
  emit({ ok: true, peer: peer.name, jobs: shown });
  if (isJson()) return;
  ui.head("twin jobs", peer.name);
  if (jobs.length === 0) {
    ui.info('No jobs yet. Try `twin run "..."`');
    ui.gap();
    return;
  }
  for (const j of shown) {
    const facts = [duration(j.durationMs), money(j.costUsd)]
      .filter(Boolean)
      .join(" · ");
    ui.row(
      [
        pc.cyan(j.id),
        STATUS[j.status],
        pc.dim(ago(j.startedAt)),
        fromHome(j.dir),
        pc.dim(facts),
      ],
      [8, 12, 12, 26, 0],
    );
    ui.say(
      `  ${" ".repeat(8)}  ${pc.dim(j.prompt.replace(/\s+/g, " ").slice(0, 80))}`,
    );
  }
  ui.gap();
}

export async function logsCommand(
  ref: string | undefined,
  flags: { on?: string; follow?: boolean; raw?: boolean },
) {
  const peer = getPeer(flags.on);
  const job = await findJob(peer, ref);
  if (!isJson() && !flags.raw)
    ui.head(
      `twin logs ${pc.cyan(job.id)}`,
      `${STATUS[job.status]} · ${job.prompt.slice(0, 60)}`,
    );
  const events: unknown[] = [];
  await followJob(
    peer,
    job,
    (line) => {
      if (flags.raw) process.stdout.write(`${line}\n`);
      else if (isJson()) events.push(JSON.parse(line));
      else renderEvent(line, peer.name);
    },
    Boolean(flags.follow) && job.status === "running",
  );
  if (isJson()) emit({ ok: true, job, events });
  if (!isJson() && !flags.raw && job.status === "crashed")
    ui.fail(job.error ?? "Crashed");
}

export async function fetchCommand(
  ref: string | undefined,
  flags: { on?: string; here?: boolean },
) {
  const peer = getPeer(flags.on);
  if (flags.here) return fetchHere(peer);
  const job = await findJob(peer, ref);
  if (job.status === "running") {
    throw new TwinError(
      "still_running",
      `Job ${job.id} is still running.`,
      `twin logs ${job.id} -f`,
    );
  }
  const spin = spinner(`Bringing back ${fromHome(job.dir)}`);
  const { changed } = await fetchJob(peer, job);
  spin.stop();
  emit({ ok: true, job, changed });
  ui.head(`twin fetch ${pc.cyan(job.id)}`, `${STATUS[job.status]}`);
  if (job.result) ui.say(job.result.trim().replace(/^/gm, "  "));
  printFetched(job, changed);
}

export async function stopCommand(
  ref: string | undefined,
  flags: { on?: string },
) {
  const peer = getPeer(flags.on);
  const job = await findJob(peer, ref);
  await stopJob(peer, job);
  emit({ ok: true, stopped: job.id });
  ui.gap();
  ui.ok(`Stopped ${pc.cyan(job.id)} on ${peer.name}`);
  ui.gap();
}

export async function attachCommand(
  ref: string | undefined,
  flags: { on?: string },
) {
  const peer = getPeer(flags.on);
  const job = await findJob(peer, ref);
  if (job.status === "running") {
    throw new TwinError(
      "still_running",
      `Job ${job.id} is still running.`,
      `Watch it with \`twin logs ${job.id} -f\`, or stop it first.`,
    );
  }
  process.exitCode = await shTty(
    peer,
    `cd "$HOME"/${shq(fromHome(job.dir))} && exec claude --resume ${job.sessionId}`,
    { unlock: true },
  );
}

async function fetchHere(peer: Peer) {
  const dir = process.cwd();
  if (!isInsideHome(dir))
    throw new TwinError("bad_dir", `${dir} is outside your home folder.`);
  const spin = spinner(`Bringing back ${fromHome(dir)} from ${peer.name}`);
  const changed = await transfer(peer, {
    from: "remote",
    path: fromHome(dir),
    dir: true,
    excludes: PROJECT_EXCLUDES,
  });
  await pullSessions(peer, dir);
  spin.stop();
  const files = changed.filter((f) => !f.startsWith(".git/"));
  emit({ ok: true, dir, changed: files });
  ui.gap();
  ui.ok(
    files.length
      ? `Brought back ${plural(files.length, "changed file")}`
      : "Already up to date",
  );
  for (const f of files.slice(0, 15)) ui.info(f);
  ui.gap();
}
