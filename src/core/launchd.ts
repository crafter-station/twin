import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Peer } from "./config.ts";
import { TwinError } from "./errors.ts";
import { HOME } from "./paths.ts";
import { run } from "./proc.ts";
import { sh, shOk } from "./ssh.ts";
import { writeText } from "./store.ts";

export const SYNC_LABEL = "run.crafter.twin.sync";
export const RC_LABEL = "run.crafter.twin.rc";

type Agent = {
  label: string;
  args: string[];
  log: string;
  interval?: number;
  keepAlive?: boolean;
  env?: Record<string, string>;
  processType?: "Background" | "Standard" | "Interactive";
};

const xml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function plist(agent: Agent) {
  const strings = (items: string[]) =>
    items.map((s) => `    <string>${xml(s)}</string>`).join("\n");
  const env = Object.entries(agent.env ?? {})
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${agent.label}</string>
  <key>ProgramArguments</key>
  <array>
${strings(agent.args)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
${agent.interval ? `  <key>StartInterval</key>\n  <integer>${agent.interval}</integer>\n` : ""}${agent.keepAlive ? "  <key>KeepAlive</key>\n  <true/>\n  <key>ThrottleInterval</key>\n  <integer>30</integer>\n" : ""}  <key>ProcessType</key>
  <string>${agent.processType ?? "Background"}</string>
  <key>StandardOutPath</key>
  <string>${xml(agent.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(agent.log)}</string>
</dict>
</plist>
`;
}

const agentPath = (home: string, label: string) =>
  join(home, "Library", "LaunchAgents", `${label}.plist`);

const uid = () => String(process.getuid?.() ?? 501);

export async function installLocal(agent: Agent) {
  const path = agentPath(HOME, agent.label);
  await run("launchctl", ["bootout", `gui/${uid()}/${agent.label}`]);
  writeText(path, plist(agent));
  const result = await run("launchctl", ["bootstrap", `gui/${uid()}`, path]);
  if (result.code !== 0) throw new Error(result.stderr.trim());
}

export async function removeLocal(label: string) {
  await run("launchctl", ["bootout", `gui/${uid()}/${label}`]);
  const path = agentPath(HOME, label);
  if (existsSync(path)) unlinkSync(path);
}

export async function isLoadedLocal(label: string) {
  return (
    (await run("launchctl", ["print", `gui/${uid()}/${label}`])).code === 0
  );
}

export async function installRemote(peer: Peer, agent: Agent) {
  const path = `$HOME/Library/LaunchAgents/${agent.label}.plist`;
  await shOk(
    peer,
    `mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.twin" && launchctl bootout gui/$(id -u)/${agent.label} 2>/dev/null; cat > "${path}" && launchctl bootstrap gui/$(id -u) "${path}"`,
    { input: plist(agent) },
  );
}

export async function removeRemote(peer: Peer, label: string) {
  await sh(
    peer,
    `launchctl bootout gui/$(id -u)/${label} 2>/dev/null; rm -f "$HOME/Library/LaunchAgents/${label}.plist"; true`,
  );
}

export const GUI_HINT =
  "It needs someone logged in on its screen. After a restart, unlock FileVault and log in once (on the screen, or over SSH then Screen Sharing). For planned restarts use `sudo fdesetup authrestart`.";

export async function runInSession(
  peer: Peer,
  agent: Agent,
  plistPath: string,
) {
  await shOk(
    peer,
    `mkdir -p "$(dirname "${plistPath}")" && cat > "${plistPath}"`,
    {
      input: plist(agent),
    },
  );
  const result = await sh(
    peer,
    `launchctl bootout gui/$(id -u)/${agent.label} 2>/dev/null; launchctl bootstrap gui/$(id -u) "${plistPath}"`,
  );
  if (result.code !== 0) {
    throw new TwinError(
      "no_session",
      `${peer.name} has no desktop session to run Claude in.`,
      GUI_HINT,
    );
  }
}
