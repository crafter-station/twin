import { homedir } from "node:os";
import { join, relative } from "node:path";

export const HOME = homedir();
export const CLAUDE_DIR = join(HOME, ".claude");
export const CLAUDE_JSON = join(HOME, ".claude.json");
export const SETTINGS = join(CLAUDE_DIR, "settings.json");
export const TWIN_DIR = join(HOME, ".twin");

export const PATHS = {
  config: join(TWIN_DIR, "config.json"),
  state: join(TWIN_DIR, "state.json"),
  sshConfig: join(TWIN_DIR, "ssh_config"),
  sockets: join(TWIN_DIR, "s"),
  backups: join(TWIN_DIR, "backups"),
  logs: join(TWIN_DIR, "logs"),
  lock: join(TWIN_DIR, "sync.lock"),
};

export const REMOTE_ENV =
  'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"';

export const projectKey = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, "-");

export const fromHome = (path: string) => relative(HOME, path);

export const isInsideHome = (path: string) => {
  const rel = fromHome(path);
  return rel !== "" && !rel.startsWith("..");
};

export const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
