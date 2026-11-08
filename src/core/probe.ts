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
  desktop: boolean;
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
  a=$(claude auth status 2>/dev/null | grep -c '"loggedIn": *true')
  if [ "$a" = 0 ] && launchctl print gui/$(id -u) >/dev/null 2>&1; then
    o="$HOME/.twin/auth.out"; p="$HOME/.twin/auth.plist"; rm -f "$o"; mkdir -p "$HOME/.twin"
    printf '%s' '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>run.crafter.twin.auth</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>"$HOME/.local/bin/claude" auth status > "$HOME/.twin/auth.tmp" 2>&1; mv "$HOME/.twin/auth.tmp" "$HOME/.twin/auth.out"</string></array><key>RunAtLoad</key><true/></dict></plist>' > "$p"
    launchctl bootout gui/$(id -u)/run.crafter.twin.auth 2>/dev/null
    launchctl bootstrap gui/$(id -u) "$p" 2>/dev/null
    i=0; while [ ! -f "$o" ] && [ $i -lt 40 ]; do sleep 0.25; i=$((i+1)); done
    launchctl bootout gui/$(id -u)/run.crafter.twin.auth 2>/dev/null
    a=$(grep -c '"loggedIn": *true' "$o" 2>/dev/null || echo 0)
  fi
  echo "auth=$a"
  launchctl print gui/$(id -u) >/dev/null 2>&1 && echo gui=1 || echo gui=0
fi
echo "sleep=$(pmset -g 2>/dev/null | awk '$1=="sleep"{print $2}')"
echo "cleanup=$(grep -o '"cleanupPeriodDays"[^,}]*' "$HOME/.claude/settings.json" 2>/dev/null | grep -o '[0-9][0-9]*')"
launchctl print gui/$(id -u)/${RC_LABEL} >/dev/null 2>&1 && ! tail -n 5 "$HOME/.twin/rc.log" 2>/dev/null | grep -q "got no answer" && echo rc=1 || echo rc=0
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
    desktop: kv.get("gui") === "1",
    jobsRunning: num("jobs") ?? 0,
  };
}
