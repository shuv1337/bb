import { createServer, type Server } from "node:http";
import {
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
  loadOpenCodeHostDiscovery,
  resolveOpenCodeHostNativeRoots,
} from "./host.js";
import { openCodeCommandCatalogDirectory } from "./native-roots.js";

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
    discovery: { appId: "shuvcode", catalogSkills: [], catalogCommands: null },
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
    discovery: { appId: "shuvcode", catalogSkills: [], catalogCommands: null },
  });
  const parsed = experimental_nativeRootsResolveOutputSchema.parse(answer);
  expect(parsed.skills.map((root) => root.path)).toEqual([
    join(homeDir, ".config", "shuvcode", "skills"),
  ]);
});

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("OpenCode fixture did not bind a port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

it("prefers GET /api/skill and GET /api/command when the service is ready", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bb-opencode-cwd-"));
  const skillDir = join(homeDir, "extra", "nested", "team");
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, "SKILL.md");
  writeFileSync(skillFile, "---\nname: team\n---\n");
  const urls: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    urls.push(url.split("?")[0] ?? url);
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/api/info")) {
      res.end(
        JSON.stringify({ version: "2.0.10", pid: 7, urls: [], paths: {} }),
      );
      return;
    }
    if (url.startsWith("/api/skill")) {
      res.end(
        JSON.stringify({
          location: { directory: cwd },
          data: [
            {
              id: "nested/team",
              name: "team",
              description: "team skill",
              path: skillFile,
              content: "hi",
            },
          ],
        }),
      );
      return;
    }
    if (url.startsWith("/api/command")) {
      res.end(
        JSON.stringify({
          location: { directory: cwd },
          data: [{ name: "team/review", description: "Review the diff" }],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const baseUrl = await listen(server);
  const catalogDir = openCodeCommandCatalogDirectory({
    appId: "opencode",
    cwd,
  });
  try {
    const discovery = await loadOpenCodeHostDiscovery({
      cwd,
      env: { BB_OPENCODE_SERVER: baseUrl },
      homedir: homeDir,
    });
    expect(urls).toContain("/api/skill");
    expect(urls).toContain("/api/command");
    expect(discovery.catalogCommands).toEqual([
      { name: "team/review", description: "Review the diff" },
    ]);
    const answer = await resolveOpenCodeHostNativeRoots({
      homeDir,
      env: {},
      cwd,
      discovery,
    });
    const parsed = experimental_nativeRootsResolveOutputSchema.parse(answer);
    expect(parsed.skills.map((root) => root.path)).toEqual([
      join(homeDir, ".config", "opencode", "skills"),
      skillFile,
    ]);
    expect(parsed.commands.map((root) => root.path)).toEqual([catalogDir]);
    expect(
      readFileSync(join(catalogDir, "team", "review.md"), "utf8"),
    ).toContain('description: "Review the diff"');
  } finally {
    await closeServer(server);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(catalogDir, { recursive: true, force: true });
  }
});

it("keeps catalog skills and falls back to filesystem commands when GET /api/command fails", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bb-opencode-cwd-"));
  const skillDir = join(homeDir, "extra", "team");
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, "SKILL.md");
  writeFileSync(skillFile, "---\nname: team\n---\n");
  const urls: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    urls.push(url.split("?")[0] ?? url);
    if (url.startsWith("/api/command")) {
      res.statusCode = 500;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/api/info")) {
      res.end(
        JSON.stringify({ version: "2.0.10", pid: 7, urls: [], paths: {} }),
      );
      return;
    }
    if (url.startsWith("/api/skill")) {
      res.end(
        JSON.stringify({
          location: { directory: cwd },
          data: [
            {
              id: "team",
              name: "team",
              path: skillFile,
              content: "hi",
            },
          ],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const baseUrl = await listen(server);
  try {
    const discovery = await loadOpenCodeHostDiscovery({
      cwd,
      env: { BB_OPENCODE_SERVER: baseUrl },
      homedir: homeDir,
    });
    expect(urls).toContain("/api/skill");
    expect(urls).toContain("/api/command");
    expect(discovery.catalogSkills).toEqual([
      { id: "team", name: "team", path: skillFile },
    ]);
    expect(discovery.catalogCommands).toBeNull();
    const answer = await resolveOpenCodeHostNativeRoots({
      homeDir,
      env: {},
      cwd,
      discovery,
    });
    const parsed = experimental_nativeRootsResolveOutputSchema.parse(answer);
    expect(parsed.skills.map((root) => root.path)).toContain(skillFile);
    expect(parsed.commands.map((root) => root.path)).toContain(
      join(homeDir, ".config", "opencode", "commands"),
    );
  } finally {
    await closeServer(server);
    rmSync(cwd, { recursive: true, force: true });
  }
});
