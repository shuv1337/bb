import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_nativeRootsResolveOutputSchema } from "@get-bb/plugin-sdk/host";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resolveOpenCodeHostNativeRoots } from "./host.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "bb-opencode-host-roots-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

it("uses discovered shuvcode app roots with no BB_OPENCODE_APP override", async () => {
  const answer = await resolveOpenCodeHostNativeRoots({
    homeDir,
    env: {},
    cwd: null,
    discovery: { appId: "shuvcode", catalogSkills: [] },
  });
  const parsed = experimental_nativeRootsResolveOutputSchema.parse(answer);
  expect(parsed.skills.map((root) => root.path)).toEqual([
    join(homeDir, ".config", "shuvcode", "skills"),
  ]);
});

it("still resolves the discovered app when cwd is null", async () => {
  const answer = await resolveOpenCodeHostNativeRoots({
    homeDir,
    env: { OPENCODE_CONFIG_DIR: "~/ignored-for-shuvcode" },
    cwd: null,
    discovery: { appId: "shuvcode", catalogSkills: [] },
  });
  const parsed = experimental_nativeRootsResolveOutputSchema.parse(answer);
  expect(parsed.skills.map((root) => root.path)).toEqual([
    join(homeDir, ".config", "shuvcode", "skills"),
  ]);
});
