# twin

TypeScript CLI, ESM, Node 20+, macOS only. Built with tsup into `dist/bin/twin.js`; `npm link` exposes `twin`.

- `src/core`: transport and logic. `net.ts` picks the route, `ssh.ts` runs remote scripts through `/bin/sh -c` with a ControlMaster socket, `rsync.ts` wraps the system openrsync (`-a -i -u`, backups with `-b --backup-dir`), `sync.ts` orchestrates scopes, `merge.ts` merges history and MCP servers, `jobs.ts` runs headless `claude -p --output-format stream-json` on the peer, `doctor.ts` holds checks with optional fixes, `launchd.ts` installs agents.
- `src/commands`: one file per command group, thin over core.
- `src/ui`: `out.ts` is the only place that writes to the terminal; `emit()` prints JSON when `--json` is set.
- `skill/SKILL.md`: shipped skill, installed by `twin skill` and `twin setup`.

Rules: no comments, no em dashes in user-facing text, never delete on the remote, every command must work with `--json`, errors are `TwinError(code, message, hint)`.

Check: `npm run typecheck && npm run lint && npm run build`.
