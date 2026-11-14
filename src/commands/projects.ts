import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import pc from "picocolors";
import { type LinkedProject, loadConfig, saveConfig } from "../core/config.ts";
import { TwinError } from "../core/errors.ts";
import { fromHome, HOME, isInsideHome } from "../core/paths.ts";
import { excludesOf, forgetProject, linkedProjects } from "../core/projects.ts";
import { PROJECT_EXCLUDES } from "../core/scopes.ts";
import { emit, plural, ui } from "../ui/out.ts";

type LinkFlags = { all?: boolean; exclude?: string };

function locate(dir?: string) {
  const abs = resolve(dir ?? process.cwd());
  if (!isInsideHome(abs)) {
    throw new TwinError(
      "outside_home",
      `${abs} is not inside your home folder.`,
      "Only folders under your home folder can be linked.",
    );
  }
  return fromHome(abs);
}

const inside = (a: string, b: string) => a === b || a.startsWith(`${b}/`);

const describe = (project: LinkedProject) => ({
  path: project.path,
  excludes: excludesOf(project),
  exists: existsSync(join(HOME, project.path)),
});

export function linkCommand(dir: string | undefined, flags: LinkFlags) {
  const path = locate(dir);
  const abs = join(HOME, path);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new TwinError("not_a_folder", `${abs} is not a folder.`);
  }
  const config = loadConfig();
  const others = (config.projects ?? []).filter((p) => p.path !== path);
  const clash = others.find(
    (p) => inside(path, p.path) || inside(p.path, path),
  );
  if (clash) {
    throw new TwinError(
      "nested_project",
      `~/${path} overlaps ~/${clash.path}, which is already linked.`,
      `Run \`twin unlink ~/${clash.path}\` first.`,
    );
  }
  const extra = (flags.exclude ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const project: LinkedProject = { path };
  if (flags.all || extra.length > 0) {
    project.excludes = [...(flags.all ? [] : PROJECT_EXCLUDES), ...extra];
  }
  saveConfig({ ...config, projects: [...others, project] });
  emit({ ok: true, project: describe(project) });
  ui.gap();
  ui.ok(`Linked ${pc.bold(`~/${path}`)}`);
  const skipped = excludesOf(project);
  ui.info(
    skipped.length === 0
      ? "Every file syncs, nothing is skipped"
      : `Everything syncs except ${skipped.slice(0, 4).join(", ")}${skipped.length > 4 ? ` and ${skipped.length - 4} more` : ""}`,
  );
  ui.hint(`Run ${pc.bold("twin sync")} to sync it now`);
  ui.gap();
}

export function unlinkCommand(dir: string | undefined) {
  const path = locate(dir);
  const config = loadConfig();
  const project = (config.projects ?? []).find((p) => p.path === path);
  if (!project) {
    throw new TwinError(
      "not_linked",
      `~/${path} is not linked.`,
      "Run `twin projects` to see what is.",
    );
  }
  saveConfig({
    ...config,
    projects: (config.projects ?? []).filter((p) => p.path !== path),
  });
  forgetProject(project);
  emit({ ok: true, unlinked: path });
  ui.gap();
  ui.ok(`Unlinked ${pc.bold(`~/${path}`)}. The files stay on both Macs.`);
  ui.gap();
}

export function projectsCommand() {
  const projects = linkedProjects().map(describe);
  emit({ ok: true, projects });
  ui.head("twin projects", plural(projects.length, "linked folder"));
  if (projects.length === 0) {
    ui.hint(`Run ${pc.bold("twin link")} in a folder to keep it 1:1`);
  }
  for (const p of projects) {
    ui.row(
      [
        pc.bold(`~/${p.path}`),
        p.exists ? "" : pc.yellow("not on this Mac"),
        pc.dim(
          p.excludes.length === 0
            ? "everything"
            : `skips ${plural(p.excludes.length, "pattern")}`,
        ),
      ],
      [36, 16, 0],
    );
  }
  ui.gap();
}
