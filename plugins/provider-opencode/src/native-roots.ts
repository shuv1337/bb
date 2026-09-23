import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
    project: [
      { path: ".opencode/commands", ancestors: true },
      { path: ".opencode/command", ancestors: true },
    ],
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

export type OpenCodeCommandCatalogResult =
  | { status: "ready"; directory: string }
  | { status: "empty" }
  | { status: "failed" };

export interface OpenCodeCommandCatalogStore {
  materialize(args: {
    appId: string;
    cwd: string;
    commands: readonly OpenCodeCatalogCommand[];
  }): Promise<OpenCodeCommandCatalogResult>;
  dispose(): Promise<void>;
}

export interface ResolveOpenCodeNativeRootsArgs {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  cwd?: string | null;
  appId?: string;
  catalogSkills?: readonly OpenCodeCatalogSkill[];
  commandCatalog?: {
    commands: readonly OpenCodeCatalogCommand[];
    store: OpenCodeCommandCatalogStore;
  } | null;
}

type ResolvedSkillRoot = NonNullable<
  ExperimentalNativeRootsResolveAnswer["skills"]
>[number];

type ResolvedCommandRoot = NonNullable<
  ExperimentalNativeRootsResolveAnswer["commands"]
>[number];

const COMMAND_CATALOG_FILE_CAP = 256;
const COMMAND_CATALOG_ROOT = "opencode-command-catalog";

export function openCodeCommandCatalogDirectory(args: {
  dataDir: string;
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
  return path.join(
    path.resolve(args.dataDir),
    COMMAND_CATALOG_ROOT,
    safe,
    digest,
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

type CatalogFile = { segments: string[]; body: string };

function catalogFiles(
  commands: readonly OpenCodeCatalogCommand[],
): CatalogFile[] {
  const files: CatalogFile[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    if (files.length >= COMMAND_CATALOG_FILE_CAP) break;
    const segments = commandSegments(command.name);
    if (segments === null) continue;
    const key = segments.join("/");
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({ segments, body: commandMarkdown(command.description) });
  }
  return files;
}

function catalogHash(files: readonly CatalogFile[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(files.map((file) => [file.segments.join("/"), file.body])),
    )
    .digest("hex");
}

function isStrictlyInside(parent: string, child: string): boolean {
  const relativePath = path.relative(parent, child);
  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  );
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}

async function lstatOrNull(target: string) {
  return lstat(target).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
}

async function plainDirectoryChain(
  realDataDir: string,
  directory: string,
  create: boolean,
): Promise<boolean> {
  if (!isStrictlyInside(realDataDir, directory)) {
    throw new Error(
      `OpenCode command catalog ${directory} is outside ${realDataDir}`,
    );
  }
  let current = realDataDir;
  for (const segment of path.relative(realDataDir, directory).split(path.sep)) {
    current = path.join(current, segment);
    const info = await lstatOrNull(current);
    if (info === null) {
      if (!create) return false;
      await mkdir(current, { mode: 0o700 });
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(
        `OpenCode command catalog path ${current} is not a plain directory`,
      );
    }
  }
  const resolved = await realpath(directory);
  if (resolved !== directory || !isStrictlyInside(realDataDir, resolved)) {
    throw new Error(
      `OpenCode command catalog ${directory} resolves to ${resolved}`,
    );
  }
  return true;
}

async function removeCatalogEntry(
  realDataDir: string,
  directory: string,
): Promise<void> {
  if (!(await plainDirectoryChain(realDataDir, path.dirname(directory), false))) {
    return;
  }
  const info = await lstatOrNull(directory);
  if (info === null) return;
  if (info.isSymbolicLink() || !info.isDirectory()) {
    await rm(directory, { force: true });
    return;
  }
  await plainDirectoryChain(realDataDir, directory, false);
  await rm(directory, { recursive: true, force: true });
}

async function catalogIntact(
  realDataDir: string,
  directory: string,
  files: readonly CatalogFile[],
): Promise<boolean> {
  try {
    if (!(await plainDirectoryChain(realDataDir, directory, false))) {
      return false;
    }
    for (const file of files) {
      const info = await lstatOrNull(
        `${path.join(directory, ...file.segments)}.md`,
      );
      if (info === null || !info.isFile()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function createOpenCodeCommandCatalogStore(options: {
  dataDir: string;
  warn?: (message: string) => void;
}): OpenCodeCommandCatalogStore {
  const warn = options.warn ?? console.warn;
  const written = new Map<string, string>();
  let disposed = false;
  let swept = false;

  async function realDataDirectory(): Promise<string> {
    const dataDir = path.resolve(options.dataDir);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    return realpath(dataDir);
  }

  async function removeDirectory(
    realDataDir: string,
    directory: string,
  ): Promise<void> {
    written.delete(directory);
    await removeCatalogEntry(realDataDir, directory);
  }

  async function sweepOrphans(realDataDir: string): Promise<void> {
    if (swept) return;
    const root = path.join(realDataDir, COMMAND_CATALOG_ROOT);
    if (await plainDirectoryChain(realDataDir, root, false)) {
      for (const app of await readdir(root, { withFileTypes: true })) {
        const appDirectory = path.join(root, app.name);
        if (!app.isDirectory()) {
          await removeCatalogEntry(realDataDir, appDirectory);
          continue;
        }
        if (!(await plainDirectoryChain(realDataDir, appDirectory, false))) {
          continue;
        }
        for (const entry of await readdir(appDirectory)) {
          const directory = path.join(appDirectory, entry);
          if (!written.has(directory)) {
            await removeCatalogEntry(realDataDir, directory);
          }
        }
      }
    }
    swept = true;
  }

  let queue: Promise<unknown> = Promise.resolve();
  function serialized<Result>(task: () => Promise<Result>): Promise<Result> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function materialize(args: {
    appId: string;
    cwd: string;
    commands: readonly OpenCodeCatalogCommand[];
  }): Promise<OpenCodeCommandCatalogResult> {
    if (disposed) return { status: "failed" };
    const files = catalogFiles(args.commands);
    try {
      const realDataDir = await realDataDirectory();
      await sweepOrphans(realDataDir);
      const directory = openCodeCommandCatalogDirectory({
        dataDir: realDataDir,
        appId: args.appId,
        cwd: args.cwd,
      });
      if (files.length === 0) {
        await removeDirectory(realDataDir, directory);
        return { status: "empty" };
      }
      const hash = catalogHash(files);
      if (
        written.get(directory) === hash &&
        (await catalogIntact(realDataDir, directory, files))
      ) {
        return { status: "ready", directory };
      }
      await removeDirectory(realDataDir, directory);
      await plainDirectoryChain(realDataDir, directory, true);
      for (const file of files) {
        const filePath = `${path.join(directory, ...file.segments)}.md`;
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, file.body, "utf8");
      }
      written.set(directory, hash);
      return { status: "ready", directory };
    } catch (error) {
      warn(
        `resolveNativeRoots: could not materialize the OpenCode command catalog; using filesystem command roots (${error instanceof Error ? error.message : String(error)})`,
      );
      return { status: "failed" };
    }
  }

  async function removeWritten(): Promise<void> {
    if (written.size === 0) return;
    let realDataDir: string;
    try {
      realDataDir = await realpath(path.resolve(options.dataDir));
    } catch (error) {
      warn(
        `OpenCode command catalog cleanup failed (${error instanceof Error ? error.message : String(error)})`,
      );
      return;
    }
    for (const directory of [...written.keys()]) {
      try {
        await removeDirectory(realDataDir, directory);
      } catch (error) {
        warn(
          `OpenCode command catalog cleanup failed for ${directory} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  }

  return {
    materialize: (args) => serialized(() => materialize(args)),
    dispose: () => {
      disposed = true;
      return serialized(removeWritten);
    },
  };
}

function filesystemCommandRoots(args: {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  appId: string;
  appConfigDir: string;
}): ResolvedCommandRoot[] {
  const roots: ResolvedCommandRoot[] = [];
  const seen = new Set<string>();
  const push = (rootPath: string) => {
    const resolved = path.resolve(rootPath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    roots.push({ path: resolved, origin: "user", shape: "commands" });
  };
  push(path.join(args.appConfigDir, "commands"));
  push(path.join(args.appConfigDir, "command"));
  if (args.appId === DEFAULT_OPENCODE_APP_ID) {
    const customDir = args.env.OPENCODE_CONFIG_DIR?.trim();
    if (customDir) {
      const base = resolveStoredPath(args.homeDir, customDir);
      push(path.join(base, "commands"));
      push(path.join(base, "command"));
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
  const preferred = env.OPENCODE_APP?.trim();
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
  const catalog: OpenCodeCommandCatalogResult =
    args.commandCatalog == null
      ? { status: "failed" }
      : await args.commandCatalog.store.materialize({
          appId,
          cwd: args.cwd ?? "",
          commands: args.commandCatalog.commands,
        });
  const commands: ResolvedCommandRoot[] =
    catalog.status === "ready"
      ? [{ path: catalog.directory, origin: "user", shape: "commands" }]
      : catalog.status === "empty"
        ? []
        : filesystemCommandRoots({
            homeDir: args.homeDir,
            env: args.env,
            appId,
            appConfigDir,
          });
  const filtered = experimental_filterResolvedNativeRoots(
    { skills, commands },
    { warn: console.warn },
  );
  return {
    skills: filtered.answer.skills,
    commands: filtered.answer.commands,
  };
}
