import { createHash } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import {
  experimental_filterResolvedNativeRoots,
  type ExperimentalNativeRootsResolveAnswer,
} from "@get-bb/plugin-sdk/host";

const CLAUDE_SKILLS_ROOT = {
  path: ".claude/skills",
  skipIfManifest: ".claude-plugin/plugin.json",
} as const;

export const OPENCODE_NATIVE_ROOTS_DECLARATION: Pick<
  PluginProviderDeclaration,
  | "experimental_nativeSkillRoots"
  | "experimental_nativeCommandRoots"
  | "experimental_resolvesNativeRoots"
> = {
  experimental_nativeSkillRoots: {
    user: [
      { ...CLAUDE_SKILLS_ROOT, recursive: true },
      { path: ".agents/skills", recursive: true },
    ],
    project: [
      { path: ".opencode/skills", recursive: true, ancestors: true },
      { ...CLAUDE_SKILLS_ROOT, recursive: true, ancestors: true },
      { path: ".agents/skills", recursive: true, ancestors: true },
    ],
  },
  experimental_nativeCommandRoots: {
    project: [{ path: ".opencode/commands", ancestors: true }],
  },
  experimental_resolvesNativeRoots: true,
};

export const DEFAULT_OPENCODE_APP_ID = "opencode";

export type OpenCodeCatalogSkill = {
  id: string;
  name?: string;
  path: string;
};

export type OpenCodeCatalogCommand = {
  name: string;
  description?: string;
};

export interface ResolveOpenCodeNativeRootsArgs {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  cwd?: string | null;
  appId?: string;
  catalogSkills?: readonly OpenCodeCatalogSkill[];
  catalogCommands?: readonly OpenCodeCatalogCommand[] | null;
  commandCatalogDir?: string;
}

type ResolvedSkillRoot = NonNullable<
  ExperimentalNativeRootsResolveAnswer["skills"]
>[number];

type ResolvedCommandRoot = NonNullable<
  ExperimentalNativeRootsResolveAnswer["commands"]
>[number];

const COMMAND_CATALOG_FILE_CAP = 256;

export function openCodeCommandCatalogDirectory(args: {
  appId: string;
  cwd: string;
}): string {
  const safe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(args.appId)
    ? args.appId
    : DEFAULT_OPENCODE_APP_ID;
  const digest = createHash("sha256")
    .update(path.resolve(args.cwd))
    .digest("hex")
    .slice(0, 16);
  return path.join(tmpdir(), "bb-opencode-command-catalog", safe, digest);
}

function isUnderTemporaryDirectory(directory: string): boolean {
  const root = path.resolve(tmpdir());
  const resolved = path.resolve(directory);
  const relativePath = path.relative(root, resolved);
  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  );
}

function commandSegments(name: string): string[] | null {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 240) return null;
  const segments = trimmed.split("/");
  if (segments.length > 8) return null;
  const safe: string[] = [];
  for (const raw of segments) {
    const segment = raw.trim();
    if (
      segment.length === 0 ||
      segment.length > 128 ||
      segment === "." ||
      segment === ".." ||
      segment.startsWith(".") ||
      /[\\/:\0\r\n]/u.test(segment)
    ) {
      return null;
    }
    safe.push(segment);
  }
  return safe;
}

function commandMarkdown(description: string | undefined): string {
  if (description === undefined) return "\n";
  const oneLine = description
    .replace(/[\r\n]+/gu, " ")
    .replace(/---/gu, " ")
    .trim()
    .slice(0, 500);
  if (oneLine.length === 0) return "\n";
  const escaped = oneLine.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
  return `---\ndescription: "${escaped}"\n---\n`;
}

async function replaceCatalogCommandFiles(
  directory: string,
  commands: readonly OpenCodeCatalogCommand[],
): Promise<boolean> {
  if (!isUnderTemporaryDirectory(directory)) {
    console.warn(
      `resolveNativeRoots: refused to materialize OpenCode commands outside the temporary directory (${directory})`,
    );
    return false;
  }
  const resolved = path.resolve(directory);
  await rm(resolved, { recursive: true, force: true });
  const files: { filePath: string; body: string }[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    if (files.length >= COMMAND_CATALOG_FILE_CAP) break;
    const segments = commandSegments(command.name);
    if (segments === null) continue;
    const key = segments.join("/");
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({
      filePath: `${path.join(resolved, ...segments)}.md`,
      body: commandMarkdown(command.description),
    });
  }
  if (files.length === 0) return false;
  await mkdir(resolved, { recursive: true });
  for (const file of files) {
    await mkdir(path.dirname(file.filePath), { recursive: true });
    await writeFile(file.filePath, file.body, "utf8");
  }
  return true;
}

async function filesystemCommandRoots(args: {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string | null | undefined;
  appId: string;
  appConfigDir: string;
}): Promise<ResolvedCommandRoot[]> {
  const roots: ResolvedCommandRoot[] = [];
  const seen = new Set<string>();
  const push = (rootPath: string, origin: "user" | "project") => {
    const resolved = path.resolve(rootPath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    roots.push({ path: resolved, origin, shape: "commands" });
  };
  push(path.join(args.appConfigDir, "commands"), "user");
  push(path.join(args.appConfigDir, "command"), "user");
  if (args.appId === DEFAULT_OPENCODE_APP_ID) {
    const customDir = args.env.OPENCODE_CONFIG_DIR?.trim();
    if (customDir) {
      const base = resolveStoredPath(args.homeDir, customDir);
      push(path.join(base, "commands"), "user");
      push(path.join(base, "command"), "user");
    }
  }
  if (args.cwd) {
    for (const ancestor of await projectAncestorDirectories(args.cwd)) {
      push(path.join(ancestor, ".opencode", "command"), "project");
    }
  }
  return roots;
}

function resolveStoredPath(homeDir: string, value: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(homeDir, value);
}

export function resolveOpenCodeAppId(
  env: Readonly<Record<string, string | undefined>>,
  override?: string,
): string {
  const explicit = override?.trim();
  if (explicit) return explicit;
  const preferred = env.BB_OPENCODE_APP?.trim();
  if (preferred) return preferred;
  return DEFAULT_OPENCODE_APP_ID;
}

export function resolveOpenCodeAppConfigDir(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
  appId: string,
): string {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  return xdgConfigHome
    ? path.join(resolveStoredPath(homeDir, xdgConfigHome), appId)
    : path.join(homeDir, ".config", appId);
}

function isUsableHostSkillPath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === "/builtin" || trimmed.startsWith("/builtin/")) return false;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) return false;
  return path.isAbsolute(trimmed);
}

function isPathInside(parent: string, child: string): boolean {
  const relativePath = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

async function hasGitMarker(directoryPath: string): Promise<boolean> {
  try {
    await stat(path.join(directoryPath, ".git"));
    return true;
  } catch {
    return false;
  }
}

export async function projectAncestorDirectories(
  cwd: string,
): Promise<string[]> {
  const directories: string[] = [];
  let directoryPath = path.resolve(cwd);
  while (true) {
    directories.push(directoryPath);
    if (await hasGitMarker(directoryPath)) {
      return directories;
    }
    const parentPath = path.dirname(directoryPath);
    if (parentPath === directoryPath) {
      return [path.resolve(cwd)];
    }
    directoryPath = parentPath;
  }
}

async function declaredSkillDirectories(args: {
  homeDir: string;
  cwd: string | null | undefined;
  appSkillsDir: string;
}): Promise<string[]> {
  const directories = [
    args.appSkillsDir,
    path.join(args.homeDir, ".claude", "skills"),
    path.join(args.homeDir, ".agents", "skills"),
  ];
  if (args.cwd) {
    for (const ancestor of await projectAncestorDirectories(args.cwd)) {
      directories.push(
        path.join(ancestor, ".opencode", "skills"),
        path.join(ancestor, ".claude", "skills"),
        path.join(ancestor, ".agents", "skills"),
      );
    }
  }
  return directories;
}

async function accessibleKind(
  filePath: string,
): Promise<"file" | "directory" | null> {
  try {
    const info = await stat(filePath);
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    return null;
  } catch {
    return null;
  }
}

async function catalogSkillRoot(
  skill: OpenCodeCatalogSkill,
  declaredDirectories: readonly string[],
): Promise<ResolvedSkillRoot | null> {
  if (!isUsableHostSkillPath(skill.path)) return null;
  const resolved = path.resolve(skill.path);
  if (
    declaredDirectories.some((directory) => isPathInside(directory, resolved))
  ) {
    return null;
  }
  const kind = await accessibleKind(resolved);
  if (kind === null) return null;
  const fallbackName = skill.id.trim() || skill.name?.trim();
  if (kind === "file") {
    if (path.basename(resolved).toLowerCase() !== "skill.md") return null;
    return {
      path: resolved,
      origin: "user",
      shape: "skill-file",
      ...(fallbackName ? { fallbackName } : {}),
    };
  }
  return {
    path: resolved,
    origin: "user",
    shape: "skill",
    recursive: false,
  };
}

export async function resolveOpenCodeNativeRoots(
  args: ResolveOpenCodeNativeRootsArgs,
): Promise<ExperimentalNativeRootsResolveAnswer> {
  const appId = resolveOpenCodeAppId(args.env, args.appId);
  const appConfigDir = resolveOpenCodeAppConfigDir(
    args.homeDir,
    args.env,
    appId,
  );
  const appSkillsDir = path.join(appConfigDir, "skills");
  const skills: ResolvedSkillRoot[] = [
    {
      path: appSkillsDir,
      origin: "user",
      shape: "skills",
      recursive: true,
    },
  ];
  const customDir =
    appId === DEFAULT_OPENCODE_APP_ID
      ? args.env.OPENCODE_CONFIG_DIR?.trim()
      : undefined;
  if (customDir) {
    const customSkillsDir = path.join(
      resolveStoredPath(args.homeDir, customDir),
      "skills",
    );
    if (customSkillsDir !== appSkillsDir) {
      skills.push({
        path: customSkillsDir,
        origin: "user",
        shape: "skills",
        recursive: true,
      });
    }
  }
  const declaredDirectories = await declaredSkillDirectories({
    homeDir: args.homeDir,
    cwd: args.cwd,
    appSkillsDir,
  });
  const seen = new Set(skills.map((root) => root.path));
  for (const skill of args.catalogSkills ?? []) {
    const root = await catalogSkillRoot(skill, declaredDirectories);
    if (root === null || seen.has(root.path)) continue;
    seen.add(root.path);
    skills.push(root);
  }
  const commands: ResolvedCommandRoot[] = [];
  if (args.catalogCommands == null) {
    commands.push(
      ...(await filesystemCommandRoots({
        homeDir: args.homeDir,
        env: args.env,
        cwd: args.cwd,
        appId,
        appConfigDir,
      })),
    );
  } else {
    const directory =
      args.commandCatalogDir ??
      openCodeCommandCatalogDirectory({
        appId,
        cwd: args.cwd ?? "",
      });
    if (await replaceCatalogCommandFiles(directory, args.catalogCommands)) {
      commands.push({
        path: path.resolve(directory),
        origin: "user",
        shape: "commands",
      });
    }
  }
  const filtered = experimental_filterResolvedNativeRoots(
    { skills, commands },
    { warn: console.warn },
  );
  return {
    skills: filtered.answer.skills,
    commands: filtered.answer.commands,
  };
}
