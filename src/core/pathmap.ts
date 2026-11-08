import type { Peer } from "./config.ts";
import { HOME } from "./paths.ts";

export type PathMap = { local: string; remote: string; same: boolean };

export function pathMap(peer: Peer): PathMap {
  const remote = peer.home || HOME;
  return { local: HOME, remote, same: remote === HOME };
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const encode = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");
const SAME_NAME = "(?![A-Za-z0-9_.-])";
const PROJECTS = ".claude/projects/";

function swapText(text: string, from: string, to: string) {
  const paths = text.replace(
    new RegExp(`${literal(from)}${SAME_NAME}`, "g"),
    to,
  );
  return paths.replace(
    new RegExp(
      `/\\.claude/projects/${literal(encode(from))}(?![A-Za-z0-9])`,
      "g",
    ),
    `/.claude/projects/${encode(to)}`,
  );
}

function swapKey(rel: string, from: string, to: string) {
  if (!rel.startsWith(PROJECTS)) return rel;
  const rest = rel.slice(PROJECTS.length);
  const slash = rest.indexOf("/");
  const key = slash === -1 ? rest : rest.slice(0, slash);
  const tail = slash === -1 ? "" : rest.slice(slash);
  const prefix = encode(from);
  if (key !== prefix && !key.startsWith(`${prefix}-`)) return rel;
  return `${PROJECTS}${encode(to)}${key.slice(prefix.length)}${tail}`;
}

export const toRemoteText = (m: PathMap, text: string) =>
  m.same ? text : swapText(text, m.local, m.remote);

export const toLocalText = (m: PathMap, text: string) =>
  m.same ? text : swapText(text, m.remote, m.local);

export const toRemoteRel = (m: PathMap, rel: string) =>
  m.same ? rel : swapKey(rel, m.local, m.remote);

export const toLocalRel = (m: PathMap, rel: string) =>
  m.same ? rel : swapKey(rel, m.remote, m.local);

export function translateBytes(
  buffer: Buffer,
  swap: (text: string) => string,
): Buffer {
  if (buffer.includes(0)) return buffer;
  const text = buffer.toString("latin1");
  const next = swap(text);
  return next === text ? buffer : Buffer.from(next, "latin1");
}
