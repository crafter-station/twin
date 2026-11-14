import { TwinError } from "./errors.ts";
import { PATHS } from "./paths.ts";
import { readJson, writeJson } from "./store.ts";

export type Peer = {
  name: string;
  user: string;
  host: string;
  hostname: string;
  home: string;
  addresses: string[];
  port?: number;
  arch?: string;
  os?: string;
  pairedAt: string;
};

export type LinkedProject = { path: string; excludes?: string[] };

export type Config = {
  peers: Record<string, Peer>;
  defaultPeer?: string;
  projects?: LinkedProject[];
};

export const loadConfig = (): Config =>
  readJson<Config>(PATHS.config, { peers: {} });

export const saveConfig = (config: Config) => writeJson(PATHS.config, config);

export const allPeers = () => Object.values(loadConfig().peers);

export function getPeer(name?: string): Peer {
  const config = loadConfig();
  const names = Object.keys(config.peers);
  if (names.length === 0) {
    throw new TwinError(
      "no_peer",
      "No Mac paired yet.",
      "Run `twin pair` with the other Mac connected.",
    );
  }
  const key = name ?? config.defaultPeer ?? names[0] ?? "";
  const peer = config.peers[key];
  if (!peer) {
    throw new TwinError(
      "unknown_peer",
      `No paired Mac named "${key}".`,
      `Paired: ${names.join(", ")}`,
    );
  }
  return peer;
}
