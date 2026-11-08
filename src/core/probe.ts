import type { Peer } from "./config.ts";
import { RC_LABEL } from "./launchd.ts";
import { sh } from "./ssh.ts";

export type RemoteInfo = {
  home: string;
  user: string;
  hostname: string;
  arch: string;
  os: string;
  claude?: string;
  version?: string;
  loggedIn: boolean;
  sleepMinutes?: number;
  cleanupDays?: number;
  rc: boolean;
  jobsRunning: number;
};

const SCRIPT = `
echo "home=$HOME"
echo "user=$(id -un)"
echo "hostname=$(hostname -s)"
echo "arch=$(uname -m)"
echo "os=$(sw_vers -productVersion 2>/dev/null)"
c=$(command -v claude)
echo "claude=$c"
if [ -n "$c" ]; then
  echo "version=$(claude --version 2>/dev/null | head -1 | awk '{print $1}')"
  echo "auth=$(claude auth status 2>/dev/null | grep -c '"loggedIn": *true')"
fi
echo "sleep=$(pmset -g 2>/dev/null | awk '$1=="sleep"{print $2}')"
echo "cleanup=$(grep -o '"cleanupPeriodDays"[^,}]*' "$HOME/.claude/settings.json" 2>/dev/null | grep -o '[0-9][0-9]*')"
launchctl print gui/$(id -u)/${RC_LABEL} >/dev/null 2>&1 && echo rc=1 || echo rc=0
n=0
for f in "$HOME"/.twin/jobs/*.pid; do [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null && n=$((n+1)); done
echo "jobs=$n"
`;

export async function probeRemote(peer: Peer): Promise<RemoteInfo> {
  const { stdout } = await sh(peer, SCRIPT, { timeoutMs: 20_000 });
  const kv = new Map(
    stdout
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  const num = (key: string) => {
    const value = kv.get(key);
    return value ? Number(value) : undefined;
  };
  return {
    home: kv.get("home") ?? "",
    user: kv.get("user") ?? "",
    hostname: kv.get("hostname") ?? "",
    arch: kv.get("arch") ?? "",
    os: kv.get("os") ?? "",
    claude: kv.get("claude") || undefined,
    version: kv.get("version") || undefined,
    loggedIn: kv.get("auth") === "1",
    sleepMinutes: num("sleep"),
    cleanupDays: num("cleanup"),
    rc: kv.get("rc") === "1",
    jobsRunning: num("jobs") ?? 0,
  };
}
