import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_nativeRootsResolveOutputSchema } from "@get-bb/plugin-sdk/host";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  openCodeCommandCatalogDirectory,
  resolveOpenCodeNativeRoots,
} from "./native-roots.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "bb-opencode-native-roots-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

async function resolvedRoots(
  env: Readonly<Record<string, string | undefined>>,
  extra: {
    appId?: string;
    cwd?: string | null;
    catalogSkills?: Parameters<
      typeof resolveOpenCodeNativeRoots
    >[0]["catalogSkills"];
    catalogCommands?: Parameters<
      typeof resolveOpenCodeNativeRoots
    >[0]["catalogCommands"];
    commandCatalogDir?: string;
  } = {},
) {
  const answer = await resolveOpenCodeNativeRoots({
    homeDir,
    env,
    cwd: extra.cwd,
    catalogSkills: extra.catalogSkills ?? [],
    catalogCommands: extra.catalogCommands,
    commandCatalogDir: extra.commandCatalogDir,
    appId: extra.appId,
  });
  return experimental_nativeRootsResolveOutputSchema.parse(answer);
}

async function resolvedSkills(
  env: Readonly<Record<string, string | undefined>>,
  extra: {
    appId?: string;
    cwd?: string | null;
    catalogSkills?: Parameters<
      typeof resolveOpenCodeNativeRoots
    >[0]["catalogSkills"];
  } = {},
) {
  return (await resolvedRoots(env, extra)).skills;
}

it("adds the upstream config skills directory by default", async () => {
  const skills = await resolvedSkills({});
  expect(skills).toEqual([
    {
      path: join(homeDir, ".config", "opencode", "skills"),
      origin: "user",
      shape: "skills",
      recursive: true,
      ancestors: false,
      namePrefix: "",
    },
  ]);
});

it("uses a discovered app id without BB_OPENCODE_APP", async () => {
  const skills = await resolvedSkills({}, { appId: "shuvcode" });
  expect(skills.map((root) => root.path)).toEqual([
    join(homeDir, ".config", "shuvcode", "skills"),
  ]);
});

it("uses BB_OPENCODE_APP and XDG_CONFIG_HOME for the app root", async () => {
  const xdg = join(homeDir, "xdg");
  const skills = await resolvedSkills({
    BB_OPENCODE_APP: "shuvcode",
    XDG_CONFIG_HOME: xdg,
  });
  expect(skills.map((root) => root.path)).toEqual([
    join(xdg, "shuvcode", "skills"),
  ]);
});

it("honors OPENCODE_CONFIG_DIR only for upstream opencode", async () => {
  const custom = join(homeDir, "opencode-custom");
  const upstream = await resolvedSkills({
    OPENCODE_CONFIG_DIR: "~/opencode-custom",
  });
  expect(upstream.map((root) => root.path)).toEqual([
    join(homeDir, ".config", "opencode", "skills"),
    join(custom, "skills"),
  ]);
  const fork = await resolvedSkills(
    { OPENCODE_CONFIG_DIR: "~/opencode-custom" },
    { appId: "shuvcode" },
  );
  expect(fork.map((root) => root.path)).toEqual([
    join(homeDir, ".config", "shuvcode", "skills"),
  ]);
});

it("keeps accessible catalog skill files with nested ids and skips virtual paths", async () => {
  const extraDir = join(homeDir, "extra", "nested", "team");
  mkdirSync(extraDir, { recursive: true });
  const skillFile = join(extraDir, "SKILL.md");
  writeFileSync(skillFile, "---\nname: team\n---\n");
  const builtin = "/builtin/opencode.md";
  const url = "https://example.invalid/skills/one/SKILL.md";
  const declared = join(
    homeDir,
    ".agents",
    "skills",
    "home-agents-skill",
    "SKILL.md",
  );
  mkdirSync(join(homeDir, ".agents", "skills", "home-agents-skill"), {
    recursive: true,
  });
  writeFileSync(declared, "---\nname: home-agents-skill\n---\n");
  const missing = join(homeDir, "missing", "SKILL.md");
  const skills = await resolvedSkills(
    {},
    {
      catalogSkills: [
        { id: "nested/team", name: "team", path: skillFile },
        { id: "builtin", path: builtin },
        { id: "remote", path: url },
        { id: "home-agents-skill", path: declared },
        { id: "gone", path: missing },
        { id: "empty", path: "  " },
      ],
    },
  );
  expect(
    skills.map((root) => ({ path: root.path, shape: root.shape })),
  ).toEqual([
    {
      path: join(homeDir, ".config", "opencode", "skills"),
      shape: "skills",
    },
    { path: skillFile, shape: "skill-file" },
  ]);
  expect(skills[1]).toMatchObject({
    origin: "user",
    fallbackName: "nested/team",
  });
});

it("keeps a configured .agents/skills path that is not a declared home or workspace root", async () => {
  const outside = join(homeDir, "outside", ".agents", "skills", "team");
  mkdirSync(outside, { recursive: true });
  const skillFile = join(outside, "SKILL.md");
  writeFileSync(skillFile, "---\nname: team\n---\n");
  const cwd = join(homeDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const skills = await resolvedSkills(
    {},
    {
      cwd,
      catalogSkills: [{ id: "team", path: skillFile }],
    },
  );
  expect(skills.map((root) => root.path)).toEqual([
    join(homeDir, ".config", "opencode", "skills"),
    skillFile,
  ]);
});

it("falls back to filesystem command directories when the command catalog was not fetched", async () => {
  const cwd = join(homeDir, "proj");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, ".git"), "gitdir: ignored");
  const answer = await resolvedRoots(
    { OPENCODE_CONFIG_DIR: "~/opencode-custom" },
    { cwd },
  );
  expect(answer.commands.map((root) => root.path)).toEqual([
    join(homeDir, ".config", "opencode", "commands"),
    join(homeDir, ".config", "opencode", "command"),
    join(homeDir, "opencode-custom", "commands"),
    join(homeDir, "opencode-custom", "command"),
    join(cwd, ".opencode", "command"),
  ]);
  expect(answer.commands.every((root) => root.shape === "commands")).toBe(true);
  expect(answer.commands.at(-1)?.origin).toBe("project");
  expect(
    existsSync(openCodeCommandCatalogDirectory({ appId: "opencode", cwd })),
  ).toBe(false);
});

it("does not apply OPENCODE_CONFIG_DIR command directories for a fork", async () => {
  const cwd = join(homeDir, "proj");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, ".git"), "gitdir: ignored");
  const answer = await resolvedRoots(
    { OPENCODE_CONFIG_DIR: "~/opencode-custom" },
    { appId: "shuvcode", cwd },
  );
  expect(answer.commands.map((root) => root.path)).toEqual([
    join(homeDir, ".config", "shuvcode", "commands"),
    join(homeDir, ".config", "shuvcode", "command"),
    join(cwd, ".opencode", "command"),
  ]);
});

it("prefers GET /api/command names over filesystem command directories", async () => {
  const cwd = join(homeDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const catalogDir = join(homeDir, "command-catalog");
  const answer = await resolvedRoots(
    {},
    {
      cwd,
      commandCatalogDir: catalogDir,
      catalogCommands: [
        { name: "team/review", description: 'Review "the" diff' },
        { name: "init" },
        { name: "../secret" },
        { name: "a:b" },
        { name: "team/review", description: "duplicate" },
      ],
    },
  );
  expect(answer.commands).toEqual([
    {
      path: catalogDir,
      origin: "user",
      shape: "commands",
      recursive: false,
      ancestors: false,
      namePrefix: "",
    },
  ]);
  expect(readFileSync(join(catalogDir, "team", "review.md"), "utf8")).toBe(
    '---\ndescription: "Review \\"the\\" diff"\n---\n',
  );
  expect(readFileSync(join(catalogDir, "init.md"), "utf8")).toBe("\n");
  expect(existsSync(join(homeDir, "secret.md"))).toBe(false);
  expect(existsSync(join(catalogDir, "a:b.md"))).toBe(false);
  expect(answer.commands.some((root) => root.path.includes(".opencode"))).toBe(
    false,
  );
});

it("drops a command catalog that cannot be written and an empty catalog", async () => {
  const outside = "/bb-opencode-outside-tmp";
  const refused = await resolvedRoots(
    {},
    {
      catalogCommands: [{ name: "review", description: "Review" }],
      commandCatalogDir: outside,
    },
  );
  expect(refused.commands).toEqual([]);
  expect(existsSync(outside)).toBe(false);
  const catalogDir = join(homeDir, "command-catalog");
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(join(catalogDir, "old.md"), "old");
  const empty = await resolvedRoots(
    {},
    { catalogCommands: [], commandCatalogDir: catalogDir },
  );
  expect(empty.commands).toEqual([]);
  expect(existsSync(catalogDir)).toBe(false);
});
