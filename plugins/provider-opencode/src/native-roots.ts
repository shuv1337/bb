import { stat } from "node:fs/promises";
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

export interface ResolveOpenCodeNativeRootsArgs {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  cwd?: string | null;
  appId?: string;
  catalogSkills?: readonly OpenCodeCatalogSkill[];
}

type ResolvedSkillRoot = NonNullable<
  ExperimentalNativeRootsResolveAnswer["skills"]
>[number];

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
  if (declaredDirectories.some((directory) => isPathInside(directory, resolved))) {
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
  return {
    skills: experimental_filterResolvedNativeRoots(
      { skills },
      { warn: console.warn },
    ).answer.skills,
  };
}
