import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { experimental_nativeRootsResolveOutputSchema } from "@get-bb/plugin-sdk/host";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createOpenCodeCommandCatalogStore,
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
    commandCatalog?: Parameters<
      typeof resolveOpenCodeNativeRoots
    >[0]["commandCatalog"];
  } = {},
) {
  const answer = await resolveOpenCodeNativeRoots({
    homeDir,
    env,
    cwd: extra.cwd,
    catalogSkills: extra.catalogSkills ?? [],
    commandCatalog: extra.commandCatalog,
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

it("uses a discovered app id without OPENCODE_APP", async () => {
  const skills = await resolvedSkills({}, { appId: "shuvcode" });
  expect(skills.map((root) => root.path)).toEqual([
    join(homeDir, ".config", "shuvcode", "skills"),
  ]);
});

it("uses OPENCODE_APP and XDG_CONFIG_HOME for the app root", async () => {
  const xdg = join(homeDir, "xdg");
  const skills = await resolvedSkills({
    OPENCODE_APP: "shuvcode",
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

it("falls back to both user command spellings when the command catalog was not fetched", async () => {
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
  ]);
  expect(answer.commands.every((root) => root.shape === "commands")).toBe(true);
  expect(answer.commands.every((root) => root.origin === "user")).toBe(true);
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
  ]);
});

function catalogStore(dataDir: string) {
  const warnings: string[] = [];
  const store = createOpenCodeCommandCatalogStore({
    dataDir,
    warn: (message) => warnings.push(message),
  });
  return { store, warnings };
}

it("materializes GET /api/command names under the plugin data directory", async () => {
  const cwd = join(homeDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const dataDir = join(homeDir, "plugin-data");
  const { store, warnings } = catalogStore(dataDir);
  const answer = await resolvedRoots(
    {},
    {
      cwd,
      commandCatalog: {
        store,
        commands: [
          { name: "team/review", description: 'Review "the" diff' },
          { name: "init" },
          { name: "../secret" },
          { name: "a:b" },
          { name: "team/review", description: "duplicate" },
        ],
      },
    },
  );
  const catalogDir = openCodeCommandCatalogDirectory({
    dataDir: realpathSync(dataDir),
    appId: "opencode",
    cwd,
  });
  expect(
    catalogDir.startsWith(
      join(realpathSync(dataDir), "opencode-command-catalog"),
    ),
  ).toBe(true);
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
  expect(warnings).toEqual([]);
});

it("skips rewriting an unchanged command catalog and rewrites a changed one", async () => {
  const cwd = join(homeDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const { store } = catalogStore(join(homeDir, "plugin-data"));
  const first = await store.materialize({
    appId: "opencode",
    cwd,
    commands: [{ name: "review", description: "Review" }],
  });
  if (first.status !== "ready") throw new Error("catalog was not written");
  const marker = join(first.directory, "marker.txt");
  writeFileSync(marker, "kept");
  const unchanged = await store.materialize({
    appId: "opencode",
    cwd,
    commands: [{ name: "review", description: "Review" }],
  });
  expect(unchanged).toEqual(first);
  expect(existsSync(marker)).toBe(true);
  const changed = await store.materialize({
    appId: "opencode",
    cwd,
    commands: [{ name: "review", description: "Review again" }],
  });
  expect(changed).toEqual(first);
  expect(existsSync(marker)).toBe(false);
  expect(readFileSync(join(first.directory, "review.md"), "utf8")).toContain(
    "Review again",
  );
});

it("rewrites an unchanged catalog whose directory was removed", async () => {
  const cwd = join(homeDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const { store } = catalogStore(join(homeDir, "plugin-data"));
  const commands = [{ name: "review" }];
  const first = await store.materialize({ appId: "opencode", cwd, commands });
  if (first.status !== "ready") throw new Error("catalog was not written");
  rmSync(first.directory, { recursive: true, force: true });
  await store.materialize({ appId: "opencode", cwd, commands });
  expect(existsSync(join(first.directory, "review.md"))).toBe(true);
});

it("refuses a catalog root that is a symlink out of the data directory and falls back to filesystem commands", async () => {
  const cwd = join(homeDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const dataDir = join(homeDir, "plugin-data");
  mkdirSync(dataDir, { recursive: true });
  const outside = join(homeDir, "outside");
  const victim = join(outside, "opencode", "keep.md");
  mkdirSync(join(outside, "opencode"), { recursive: true });
  writeFileSync(victim, "keep");
  const staleDir = join(
    outside,
    "opencode",
    basename(
      openCodeCommandCatalogDirectory({
        dataDir: realpathSync(dataDir),
        appId: "opencode",
        cwd,
      }),
    ),
  );
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(join(staleDir, "old.md"), "old");
  symlinkSync(outside, join(dataDir, "opencode-command-catalog"));
  const { store, warnings } = catalogStore(dataDir);
  const answer = await resolvedRoots(
    {},
    {
      cwd,
      commandCatalog: { store, commands: [{ name: "review" }] },
    },
  );
  expect(answer.commands.map((root) => root.path)).toEqual([
    join(homeDir, ".config", "opencode", "commands"),
    join(homeDir, ".config", "opencode", "command"),
  ]);
  expect(readFileSync(victim, "utf8")).toBe("keep");
  expect(readFileSync(join(staleDir, "old.md"), "utf8")).toBe("old");
  expect(existsSync(join(staleDir, "review.md"))).toBe(false);
  expect(warnings).toHaveLength(1);
});

it("keeps skills and falls back to filesystem commands when the catalog cannot be written", async () => {
  const cwd = join(homeDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const dataDir = join(homeDir, "plugin-data-is-a-file");
  writeFileSync(dataDir, "not a directory");
  const skillDir = join(homeDir, "extra", "team");
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, "SKILL.md");
  writeFileSync(skillFile, "---\nname: team\n---\n");
  const { store, warnings } = catalogStore(dataDir);
  const answer = await resolvedRoots(
    {},
    {
      cwd,
      catalogSkills: [{ id: "team", path: skillFile }],
      commandCatalog: { store, commands: [{ name: "review" }] },
    },
  );
  expect(answer.skills.map((root) => root.path)).toEqual([
    join(homeDir, ".config", "opencode", "skills"),
    skillFile,
  ]);
  expect(answer.commands.map((root) => root.path)).toEqual([
    join(homeDir, ".config", "opencode", "commands"),
    join(homeDir, ".config", "opencode", "command"),
  ]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("OpenCode command catalog");
});

it("drops an empty command catalog and removes its directory", async () => {
  const cwd = join(homeDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const { store } = catalogStore(join(homeDir, "plugin-data"));
  const first = await store.materialize({
    appId: "opencode",
    cwd,
    commands: [{ name: "review" }],
  });
  if (first.status !== "ready") throw new Error("catalog was not written");
  const empty = await resolvedRoots(
    {},
    { cwd, commandCatalog: { store, commands: [{ name: "../bad" }] } },
  );
  expect(empty.commands).toEqual([]);
  expect(existsSync(first.directory)).toBe(false);
});

it("removes written catalogs on dispose", async () => {
  const dataDir = join(homeDir, "plugin-data");
  const { store } = catalogStore(dataDir);
  const one = await store.materialize({
    appId: "opencode",
    cwd: join(homeDir, "one"),
    commands: [{ name: "review" }],
  });
  const two = await store.materialize({
    appId: "shuvcode",
    cwd: join(homeDir, "two"),
    commands: [{ name: "init" }],
  });
  if (one.status !== "ready" || two.status !== "ready") {
    throw new Error("catalogs were not written");
  }
  const unrelated = join(dataDir, "unrelated.json");
  writeFileSync(unrelated, "{}");
  await store.dispose();
  expect(existsSync(one.directory)).toBe(false);
  expect(existsSync(two.directory)).toBe(false);
  expect(existsSync(unrelated)).toBe(true);
  expect(
    await store.materialize({
      appId: "opencode",
      cwd: join(homeDir, "one"),
      commands: [{ name: "review" }],
    }),
  ).toEqual({ status: "failed" });
  expect(existsSync(one.directory)).toBe(false);
});

it("rewrites an unchanged catalog whose command file was removed", async () => {
  const cwd = join(homeDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const { store } = catalogStore(join(homeDir, "plugin-data"));
  const commands = [{ name: "review" }, { name: "init" }];
  const first = await store.materialize({ appId: "opencode", cwd, commands });
  if (first.status !== "ready") throw new Error("catalog was not written");
  rmSync(join(first.directory, "init.md"));
  expect(await store.materialize({ appId: "opencode", cwd, commands })).toEqual(
    first,
  );
  expect(existsSync(join(first.directory, "init.md"))).toBe(true);
});

function swapCatalogRootForSymlink(dataDir: string, cwd: string) {
  const outside = join(homeDir, "outside");
  mkdirSync(join(outside, "opencode"), { recursive: true });
  const victim = join(
    outside,
    "opencode",
    basename(
      openCodeCommandCatalogDirectory({
        dataDir: realpathSync(dataDir),
        appId: "opencode",
        cwd,
      }),
    ),
  );
  rmSync(join(dataDir, "opencode-command-catalog"), {
    recursive: true,
    force: true,
  });
  symlinkSync(outside, join(dataDir, "opencode-command-catalog"));
  return victim;
}

it("does not return an unchanged catalog whose parent became a symlink out of the data directory", async () => {
  const cwd = join(homeDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const dataDir = join(homeDir, "plugin-data");
  const { store, warnings } = catalogStore(dataDir);
  const commands = [{ name: "review" }];
  const first = await store.materialize({ appId: "opencode", cwd, commands });
  if (first.status !== "ready") throw new Error("catalog was not written");
  const victim = swapCatalogRootForSymlink(dataDir, cwd);
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, "review.md"), "outside");
  expect(await store.materialize({ appId: "opencode", cwd, commands })).toEqual({
    status: "failed",
  });
  expect(readFileSync(join(victim, "review.md"), "utf8")).toBe("outside");
  expect(warnings).toHaveLength(1);
});

it("never unlinks a file outside the data directory through a symlinked catalog root", async () => {
  const cwd = join(homeDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const dataDir = join(homeDir, "plugin-data");
  const { store: disposing } = catalogStore(dataDir);
  const written = await disposing.materialize({
    appId: "opencode",
    cwd,
    commands: [{ name: "review" }],
  });
  if (written.status !== "ready") throw new Error("catalog was not written");
  const victim = swapCatalogRootForSymlink(dataDir, cwd);
  writeFileSync(victim, "keep");
  const { store, warnings } = catalogStore(dataDir);
  expect(
    await store.materialize({
      appId: "opencode",
      cwd,
      commands: [{ name: "review" }],
    }),
  ).toEqual({ status: "failed" });
  expect(readFileSync(victim, "utf8")).toBe("keep");
  expect(
    await store.materialize({ appId: "opencode", cwd, commands: [] }),
  ).toEqual({ status: "failed" });
  expect(readFileSync(victim, "utf8")).toBe("keep");
  expect(warnings).toHaveLength(2);
  const { store: emptyFirst } = catalogStore(dataDir);
  expect(
    await emptyFirst.materialize({ appId: "opencode", cwd, commands: [] }),
  ).toEqual({ status: "failed" });
  expect(readFileSync(victim, "utf8")).toBe("keep");
  await disposing.dispose();
  expect(readFileSync(victim, "utf8")).toBe("keep");
});

it("sweeps catalogs left by an earlier worker on first use", async () => {
  const dataDir = join(homeDir, "plugin-data");
  const orphan = join(dataDir, "opencode-command-catalog", "opencode", "0123");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, "old.md"), "old");
  const unrelated = join(dataDir, "unrelated.json");
  writeFileSync(unrelated, "{}");
  const { store, warnings } = catalogStore(dataDir);
  const first = await store.materialize({
    appId: "shuvcode",
    cwd: join(homeDir, "one"),
    commands: [{ name: "review" }],
  });
  if (first.status !== "ready") throw new Error("catalog was not written");
  expect(existsSync(orphan)).toBe(false);
  expect(existsSync(unrelated)).toBe(true);
  const second = await store.materialize({
    appId: "shuvcode",
    cwd: join(homeDir, "two"),
    commands: [{ name: "init" }],
  });
  if (second.status !== "ready") throw new Error("catalog was not written");
  expect(existsSync(join(first.directory, "review.md"))).toBe(true);
  expect(warnings).toEqual([]);
});
