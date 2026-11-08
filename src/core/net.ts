import { Socket } from "node:net";
import type { Peer } from "./config.ts";
import { TwinError } from "./errors.ts";
import { run } from "./proc.ts";

export type RouteKind = "usb-c" | "lan" | "tailscale" | "mdns";
export type Route = { address: string; kind: RouteKind; ms: number };

const RANK: Record<RouteKind, number> = {
  "usb-c": 0,
  lan: 1,
  tailscale: 2,
  mdns: 3,
};

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const TAILNET = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

export function routeKind(address: string): RouteKind {
  if (address.startsWith("169.254.")) return "usb-c";
  if (TAILNET.test(address) || address.endsWith(".ts.net")) return "tailscale";
  if (IPV4.test(address)) return "lan";
  return "mdns";
}

export function probe(
  host: string,
  port = 22,
  timeoutMs = 900,
): Promise<number | null> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = new Socket();
    const finish = (value: number | null) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () =>
      finish(Math.round((performance.now() - started) * 10) / 10),
    );
    socket.once("timeout", () => finish(null));
    socket.once("error", () => finish(null));
    socket.connect(port, host);
  });
}

async function neighbors(host: string): Promise<string[]> {
  const { stdout } = await run("arp", ["-a"], { timeoutMs: 2000 });
  return stdout
    .split("\n")
    .map((line) => line.match(/^(\S+) \(([\d.]+)\)/))
    .filter((m): m is RegExpMatchArray => m?.[1] === host)
    .map((m) => m[2] ?? "");
}

async function lookup(host: string): Promise<string[]> {
  const { stdout } = await run(
    "dscacheutil",
    ["-q", "host", "-a", "name", host],
    { timeoutMs: 2500 },
  );
  return [...stdout.matchAll(/ip_address: ([\d.]+)/g)].map((m) => m[1] ?? "");
}

const cache = new Map<string, Route>();

export async function candidates(peer: Peer): Promise<string[]> {
  const [arp, dns] = await Promise.all([
    neighbors(peer.host),
    lookup(peer.host),
  ]);
  return [...new Set([...arp, ...dns, ...peer.addresses, peer.host])].filter(
    Boolean,
  );
}

export async function resolveRoute(peer: Peer): Promise<Route> {
  const hit = cache.get(peer.name);
  if (hit) return hit;
  const tried = await candidates(peer);
  const probed = await Promise.all(
    tried.map(async (address) => ({
      address,
      kind: routeKind(address),
      ms: await probe(address, peer.port),
    })),
  );
  const live = probed
    .filter((p): p is Route => p.ms !== null)
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.ms - b.ms);
  const best = live[0];
  if (!best) {
    throw new TwinError(
      "unreachable",
      `${peer.name} is not reachable.`,
      `Check the cable or Wi-Fi, and that Remote Login is on. Tried ${tried.join(", ")}.`,
      2,
    );
  }
  cache.set(peer.name, best);
  return best;
}
