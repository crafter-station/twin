import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TWIN_DIR } from "./paths.ts";

export const PACKAGE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export const isCompiled = () =>
  import.meta.url.includes("$bunfs") ||
  (process.argv[1] ?? "").startsWith("/$bunfs");

export function selfCommand(): string[] {
  if (isCompiled()) return [process.execPath];
  return [process.execPath, realpathSync(process.argv[1] ?? "")];
}

const SKILL_PATHS = [
  join(PACKAGE_ROOT, "skill", "SKILL.md"),
  join(TWIN_DIR, "skill", "SKILL.md"),
];

export function skillText(): string | undefined {
  const found = SKILL_PATHS.find((p) => existsSync(p));
  return found ? readFileSync(found, "utf8") : undefined;
}

export function sourceEntry() {
  const dev = join(PACKAGE_ROOT, "bin", "twin.ts");
  return existsSync(dev) ? dev : join(PACKAGE_ROOT, "dist", "bin", "twin.js");
}
