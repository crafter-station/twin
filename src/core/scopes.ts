export type ScopeName = "config" | "sessions" | "history" | "mcp" | "projects";

export type FileItem = {
  path: string;
  dir: boolean;
  translate?: boolean;
  excludes?: string[];
};

export const SCOPE_NAMES: ScopeName[] = [
  "config",
  "sessions",
  "history",
  "mcp",
  "projects",
];

export const SCOPE_INFO: Record<ScopeName, string> = {
  config: "settings, CLAUDE.md, skills, commands, agents, hooks",
  sessions: "transcripts, memory, checkpoints, todos",
  history: "prompt history for up-arrow and ctrl+r",
  mcp: "MCP servers in ~/.claude.json",
  projects: "folders you link with twin link, kept 1:1 both ways",
};

export const FILE_SCOPES: Partial<Record<ScopeName, FileItem[]>> = {
  config: [
    { path: ".claude/settings.json", dir: false },
    { path: ".claude/CLAUDE.md", dir: false },
    { path: ".claude/keybindings.json", dir: false },
    { path: ".claude/skills", dir: true },
    { path: ".claude/commands", dir: true },
    { path: ".claude/agents", dir: true },
    { path: ".claude/hooks", dir: true },
    { path: ".claude/output-styles", dir: true },
    { path: ".claude/scripts", dir: true },
    { path: ".agents/skills", dir: true },
  ],
  sessions: [
    { path: ".claude/projects", dir: true },
    { path: ".claude/file-history", dir: true, translate: false },
    { path: ".claude/todos", dir: true },
    { path: ".claude/plans", dir: true },
  ],
};

export const PROJECT_EXCLUDES = [
  "node_modules",
  ".next",
  ".turbo",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".vercel/output",
  ".parcel-cache",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".gradle",
  "DerivedData",
  ".build",
  "coverage",
];

export function parseScopes(input?: string): ScopeName[] {
  if (!input || input === "all") return SCOPE_NAMES;
  const wanted = input.split(",").map((s) => s.trim());
  const bad = wanted.filter((s) => !SCOPE_NAMES.includes(s as ScopeName));
  if (bad.length > 0) {
    throw new Error(
      `Unknown scope ${bad.join(", ")}. Use ${SCOPE_NAMES.join(", ")}.`,
    );
  }
  return wanted as ScopeName[];
}
