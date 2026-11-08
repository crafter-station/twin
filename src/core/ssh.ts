import { mkdirSync } from "node:fs";
import type { Peer } from "./config.ts";
import { TwinError } from "./errors.ts";
import { resolveRoute } from "./net.ts";
import { PATHS, REMOTE_ENV } from "./paths.ts";
import { interactive, lines, type Result, run } from "./proc.ts";

export const shq = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function sshOptions(port?: number, batch = true): string[] {
  mkdirSync(PATHS.sockets, { recursive: true, mode: 0o700 });
  return [
    ...(batch ? ["-o", "BatchMode=yes"] : []),
    ...(port ? ["-p", String(port)] : []),
    "-o",
    "ConnectTimeout=6",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${PATHS.sockets}/%C`,
    "-o",
    "ControlPersist=180",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "LogLevel=ERROR",
  ];
}

export async function target(peer: Peer) {
  const route = await resolveRoute(peer);
  return `${peer.user}@${route.address}`;
}

const wrap = (script: string) =>
  `/bin/sh -c ${shq(`${REMOTE_ENV}; ${script}`)}`;

export async function sh(
  peer: Peer,
  script: string,
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<Result> {
  return run(
    "ssh",
    [...sshOptions(peer.port), await target(peer), wrap(script)],
    opts,
  );
}

export async function shOk(
  peer: Peer,
  script: string,
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<string> {
  const result = await sh(peer, script, opts);
  if (result.code !== 0) {
    throw new TwinError(
      "remote_failed",
      `Command failed on ${peer.name}: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
  return result.stdout;
}

export async function shTty(peer: Peer, script: string): Promise<number> {
  return interactive("ssh", [
    ...sshOptions(peer.port),
    "-t",
    await target(peer),
    wrap(script),
  ]);
}

export async function shLines(
  peer: Peer,
  script: string,
  onLine: (line: string) => boolean | undefined,
): Promise<number> {
  return lines(
    "ssh",
    [...sshOptions(peer.port), await target(peer), wrap(script)],
    onLine,
  );
}
