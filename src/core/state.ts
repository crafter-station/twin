import { PATHS } from "./paths.ts";
import { readJson, writeJson } from "./store.ts";

export type SyncRecord = {
  at: string;
  route: string;
  up: number;
  down: number;
  ms: number;
};

type State = {
  lastSync: Record<string, SyncRecord>;
  lastJob?: { peer: string; id: string };
};

export const loadState = (): State =>
  readJson<State>(PATHS.state, { lastSync: {} });

export function updateState(change: (state: State) => void) {
  const state = loadState();
  change(state);
  writeJson(PATHS.state, state);
}
