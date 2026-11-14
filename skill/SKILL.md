---
name: twin
description: Sync Claude Code between this user's Macs and delegate work to their Mac mini with the `twin` CLI. Use when the user wants to sync sessions, memory, skills or settings to another Mac, move to a new laptop, run a long or heavy task on the Mac mini (builds, renders, test suites, big refactors, data jobs), check what is running on the mini, bring results back, or keep working on another machine. Triggers on "mac mini", "on the mini", "send this to the mini", "delegate", "offload", "sync my claude", "other mac", "new laptop", "twin".
---

# twin

`twin` makes the user's Macs feel like the same Claude Code. It syncs `~/.claude` (settings, CLAUDE.md, skills, commands, agents, hooks, sessions, auto memory, prompt history, MCP servers) over SSH, using the USB-C cable when it is plugged in, and it runs Claude Code jobs on the other Mac.

Always pass `--json` and read the result. Every command answers `{"ok": true, ...}` or `{"ok": false, "error": {"code", "message", "hint"}}`. Exit code 2 means the other Mac is unreachable.

## Delegate a task to the mini

```bash
twin run --json "run the full test suite and fix what fails"        # returns {job:{id,sessionId,...}}
twin jobs --json                                                     # status: running, done, failed, stopped, crashed
twin logs <id> --json                                                # every event so far
twin fetch <id> --json                                               # copies changed files + the session back here
```

- `twin run` copies the current project first (no `node_modules` or build output), plus that project's memory, then starts headless Claude Code on the mini in the same path. It survives the laptop sleeping.
- Use `--wait` only for short tasks: it blocks, streams, then fetches.
- `--dir <path>` targets another project. `--mode acceptEdits|bypassPermissions|plan` changes permissions (default `auto`). `--model <id>` picks the model.
- Write the task as a complete brief. The job cannot ask questions.
- After `fetch`, tell the user which files changed. They can continue the same conversation locally with `claude --resume <sessionId>`.
- Good fits: long builds, Blender or video renders, big test suites, dependency upgrades across a repo, scraping or ETL runs, anything that would tie up the laptop.
- Jobs use the Claude subscription the mini is signed in with. `costUsd` in results is Claude Code's API-price estimate, not a charge.
- Never use it for tasks that spend real money, send messages or deploy, unless the user explicitly asked.

## Sync

```bash
twin status --json            # online, route (usb-c, lan, tailscale), pending changes, jobs
twin sync --json              # two-way, newer file wins, backups kept 14 days
twin push --json | twin pull --json
twin sync --only sessions,history --json
twin sync --dry-run --json
```

Auto sync usually runs every 5 minutes (`twin auto on`). Do not open the same session on both Macs at once; separate sessions are fine.

## Linked folders

```bash
twin link [dir] --json        # keep a folder 1:1 on both Macs (default: here)
twin unlink [dir] --json      # stop; the files stay on both Macs
twin projects --json          # what is linked
twin sync --only projects --json
```

- A linked folder syncs with every `twin sync` and with auto sync: every file both ways, `.env` files and `.git` included. Only rebuildable folders are skipped (`node_modules`, `.next`, build output); `twin link --all` syncs those too.
- twin remembers the last sync, so a file deleted on one Mac is removed on the other (moved to `~/.twin/backups`, kept 14 days), and a file changed on both Macs is reported in `projects[].conflicts`: the newer copy wins and the other is in the backups.
- If both Macs committed to the same branch, the newer tip wins, the other tip is saved as a ref listed in `projects[].kept` (`refs/twin/kept/...`), and its file changes show up as uncommitted work. Tell the user, and merge with `git merge <ref>` if they want both.
- When agents work on both Macs at once, give each its own branch so they never move the same branch.
- Use `twin link` when the user wants a folder kept in sync, and `twin send` for a one-off copy.

## When something is wrong

Run `twin doctor --json`. Each check has `level`, `title`, `hint`, `fixable`. `twin doctor --fix --json` applies the safe fixes. Some steps need the user at a keyboard: `twin pair` (asks the mini password once), `twin login` (Claude sign-in), and `sudo pmset` for sleep. Ask the user to run those themselves with the `!` prefix.
