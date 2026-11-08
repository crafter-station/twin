import { Command } from "commander";
import pc from "picocolors";
import { autoCommand, rcCommand, skillCommand } from "./commands/agents.ts";
import { installCommand } from "./commands/install.ts";
import {
  attachCommand,
  fetchCommand,
  jobsCommand,
  logsCommand,
  runCommand,
  stopCommand,
} from "./commands/jobs.ts";
import { pair } from "./commands/pair.ts";
import {
  claudeCommand,
  loginCommand,
  shellCommand,
} from "./commands/remote.ts";
import { setup } from "./commands/setup.ts";
import { doctor, status } from "./commands/status.ts";
import { syncCommand } from "./commands/sync.ts";
import { SCOPE_INFO, SCOPE_NAMES } from "./core/scopes.ts";
import { fail, setMode } from "./ui/out.ts";

const VERSION = "0.1.0";

type Action = (...args: never[]) => Promise<void> | void;

const guard =
  <T extends Action>(fn: T) =>
  async (...args: Parameters<T>) => {
    try {
      await fn(...args);
    } catch (error) {
      fail(error);
    }
  };

const scopes = SCOPE_NAMES.map(
  (s) => `    ${s.padEnd(10)}${SCOPE_INFO[s]}`,
).join("\n");

const BANNER = `
  ${pc.bold("twin")} ${pc.dim(`v${VERSION}`)}  every Mac, the same Claude Code

  ${pc.dim("Start")}
    twin pair                  find the other Mac and trust it once
    twin setup                 make it match this Mac, turn on auto sync

  ${pc.dim("Every day")}
    twin sync                  two-way sync, newer file wins
    twin status                both Macs at a glance
    twin run "fix the tests"   send a task to the other Mac
    twin jobs · logs · fetch   follow it and bring the changes back
    twin claude                open Claude Code on the other Mac, right here

  ${pc.dim("What syncs")}
${scopes}

  ${pc.dim("Agents: add --json to any command for machine output.")}
`;

export function run() {
  const program = new Command()
    .name("twin")
    .version(VERSION, "-v, --version")
    .option("--json", "machine-readable output")
    .option("-q, --quiet", "no output unless something fails")
    .option("--on <mac>", "which paired Mac to use")
    .addHelpText("beforeAll", BANNER)
    .showHelpAfterError(pc.dim("(twin --help for usage)"))
    .hook("preAction", (cmd) => {
      const o = cmd.optsWithGlobals<{ json?: boolean; quiet?: boolean }>();
      setMode({ json: Boolean(o.json), quiet: Boolean(o.quiet) });
    });

  const globals = (cmd: Command) => cmd.optsWithGlobals();

  program
    .command("pair [host]")
    .description("find the other Mac and trust it once with your SSH key")
    .option("-n, --name <name>", "short name, like mini")
    .option("-u, --user <user>", "username on the other Mac")
    .action(
      guard((host: string | undefined, _o: unknown, cmd: Command) =>
        pair(host, globals(cmd)),
      ),
    );

  program
    .command("setup")
    .description(
      "make the other Mac match this one: Claude, settings, skills, sessions, auto sync, Remote Control",
    )
    .option("--no-auto", "skip auto sync")
    .option("--no-rc", "skip Remote Control")
    .option(
      "--rc-dir <dir>",
      "folder for Remote Control sessions, relative to home",
    )
    .action(guard((_o: unknown, cmd: Command) => setup(globals(cmd))));

  for (const [name, direction, about] of [
    ["sync", "both", "two-way sync, the newer file wins"],
    ["push", "push", "send this Mac's changes to the other Mac"],
    ["pull", "pull", "bring the other Mac's changes here"],
  ] as const) {
    program
      .command(name)
      .description(about)
      .option("--only <scopes>", `comma list: ${SCOPE_NAMES.join(",")}`)
      .option("-n, --dry-run", "show what would change")
      .option(
        "--force",
        "this side wins even if the other file is newer (push and pull only)",
      )
      .option("--verbose", "list the files")
      .option("--if-reachable", "skip quietly when the other Mac is away")
      .action(
        guard((_o: unknown, cmd: Command) =>
          syncCommand(direction, globals(cmd)),
        ),
      );
  }

  program
    .command("status")
    .description("both Macs at a glance")
    .option("--fast", "skip counting pending changes")
    .action(guard((_o: unknown, cmd: Command) => status(globals(cmd))));

  program
    .command("doctor")
    .description("check everything and explain how to fix it")
    .option("--fix", "fix what can be fixed")
    .action(guard((_o: unknown, cmd: Command) => doctor(globals(cmd))));

  program
    .command("run <task...>")
    .description(
      "send a task to the other Mac; it runs headless and keeps going if you close the lid",
    )
    .option("-d, --dir <dir>", "project folder (default: here)")
    .option(
      "-m, --mode <mode>",
      "permission mode: auto, acceptEdits, bypassPermissions, plan, dontAsk",
      "auto",
    )
    .option("--model <model>", "model for the job")
    .option("--no-copy", "do not copy the project first")
    .option("-w, --wait", "stream the work live, then bring the changes back")
    .option("--no-fetch", "with --wait, leave the changes on the other Mac")
    .option("--force", "allow a folder that holds many projects")
    .action(
      guard((task: string[], _o: unknown, cmd: Command) =>
        runCommand(task, globals(cmd)),
      ),
    );

  program
    .command("jobs")
    .description("tasks on the other Mac")
    .option("-a, --all", "show every job")
    .action(guard((_o: unknown, cmd: Command) => jobsCommand(globals(cmd))));

  program
    .command("logs [job]")
    .description("what a job did, or is doing (default: the last one)")
    .option("-f, --follow", "keep streaming until it finishes")
    .option("--raw", "raw stream-json lines")
    .action(
      guard((job: string | undefined, _o: unknown, cmd: Command) =>
        logsCommand(job, globals(cmd)),
      ),
    );

  program
    .command("fetch [job]")
    .description("bring a job's file changes and session back here")
    .option("--here", "bring back this folder instead of a job")
    .action(
      guard((job: string | undefined, _o: unknown, cmd: Command) =>
        fetchCommand(job, globals(cmd)),
      ),
    );

  program
    .command("stop [job]")
    .description("stop a running job")
    .action(
      guard((job: string | undefined, _o: unknown, cmd: Command) =>
        stopCommand(job, globals(cmd)),
      ),
    );

  program
    .command("attach [job]")
    .description("continue a finished job's conversation on the other Mac")
    .action(
      guard((job: string | undefined, _o: unknown, cmd: Command) =>
        attachCommand(job, globals(cmd)),
      ),
    );

  program
    .command("claude [args...]")
    .description("open Claude Code on the other Mac in this same folder")
    .option("--no-copy", "do not copy this project first")
    .allowUnknownOption()
    .helpOption(false)
    .action(
      guard((_a: string[], _o: unknown, cmd: Command) =>
        claudeCommand(
          cmd.args.filter((a) => a !== "--no-copy" && a !== "--json"),
          globals(cmd),
        ),
      ),
    );

  program
    .command("shell")
    .description("a shell on the other Mac in this same folder")
    .action(guard((_o: unknown, cmd: Command) => shellCommand(globals(cmd))));

  program
    .command("login")
    .description("sign in to Claude Code on the other Mac")
    .action(guard((_o: unknown, cmd: Command) => loginCommand(globals(cmd))));

  program
    .command("auto [action]")
    .description("auto sync in the background: on, off, or status")
    .option("--every <minutes>", "how often", "5")
    .action(
      guard((action: string | undefined, _o: unknown, cmd: Command) =>
        autoCommand(action, globals(cmd)),
      ),
    );

  program
    .command("rc [action]")
    .description(
      "always-on Remote Control on the other Mac: on, off, logs, or status",
    )
    .option(
      "-d, --dir <dir>",
      "folder for sessions, relative to home (default: here)",
    )
    .option("-m, --mode <mode>", "permission mode for its sessions", "auto")
    .action(
      guard((action: string | undefined, _o: unknown, cmd: Command) =>
        rcCommand(action, globals(cmd)),
      ),
    );

  program
    .command("install")
    .description("install twin itself on the other Mac as a standalone binary")
    .action(guard((_o: unknown, cmd: Command) => installCommand(globals(cmd))));

  program
    .command("skill")
    .description("teach Claude Code to use twin (installs a skill)")
    .action(guard(() => skillCommand()));

  program.parseAsync(process.argv);
}
