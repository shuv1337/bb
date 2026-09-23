import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_nativeRootsResolveOutputSchema } from "@get-bb/plugin-sdk/host";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createOpenCodeHostEntry,
  loadOpenCodeHostDiscovery,
  resolveOpenCodeHostNativeRoots,
} from "./host.js";
import {
  createOpenCodeCommandCatalogStore,
  openCodeCommandCatalogDirectory,
  type OpenCodeCommandCatalogStore,
} from "./native-roots.js";

let homeDir: string;
let dataDir: string;
let commandCatalogStore: OpenCodeCommandCatalogStore;

beforeEach(() => {
  homeDir = realpathSync(
    mkdtempSync(join(tmpdir(), "bb-opencode-host-roots-")),
  );
  dataDir = join(homeDir, "plugin-data");
  commandCatalogStore = createOpenCodeCommandCatalogStore({ dataDir });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await commandCatalogStore.dispose();
  rmSync(homeDir, { recursive: true, force: true });
});

it("uses discovered shuvcode app roots with no OPENCODE_APP override", async () => {
  const answer = await resolveOpenCodeHostNativeRoots({
    homeDir,
    env: {},
    cwd: null,
    discovery: { appId: "shuvcode", catalogSkills: [], catalogCommands: null },
    commandCatalogStore,
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
    commandCatalogStore,
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
    dataDir,
    appId: "opencode",
    cwd,
  });
  try {
    const discovery = await loadOpenCodeHostDiscovery({
      cwd,
      env: { OPENCODE_SERVER_URL: baseUrl },
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
      commandCatalogStore,
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
      env: { OPENCODE_SERVER_URL: baseUrl },
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
      commandCatalogStore,
    });
    const parsed = experimental_nativeRootsResolveOutputSchema.parse(answer);
    expect(parsed.skills.map((root) => root.path)).toContain(skillFile);
    expect(parsed.commands.map((root) => root.path)).toEqual([
      join(homeDir, ".config", "opencode", "commands"),
      join(homeDir, ".config", "opencode", "command"),
    ]);
  } finally {
    await closeServer(server);
    rmSync(cwd, { recursive: true, force: true });
  }
});

function catalogServer(args: {
  cwd: string;
  password: string;
  skillFile: string;
  urls: string[];
  authorizations: (string | undefined)[];
}): Server {
  const expected = `Basic ${Buffer.from(`opencode:${args.password}`).toString("base64")}`;
  return createServer((req, res) => {
    const url = req.url ?? "/";
    args.urls.push(url.split("?")[0] ?? url);
    args.authorizations.push(req.headers.authorization);
    if (req.headers.authorization !== expected) {
      res.statusCode = 401;
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
          location: { directory: args.cwd },
          data: [
            { id: "team", name: "team", path: args.skillFile, content: "hi" },
          ],
        }),
      );
      return;
    }
    if (url.startsWith("/api/command")) {
      res.end(
        JSON.stringify({
          location: { directory: args.cwd },
          data: [{ name: "review", description: "Review the diff" }],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
}

it("reads OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD and OPENCODE_APP from the host worker env", async () => {
  const cwd = join(homeDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const skillDir = join(homeDir, "extra", "team");
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, "SKILL.md");
  writeFileSync(skillFile, "---\nname: team\n---\n");
  const urls: string[] = [];
  const authorizations: (string | undefined)[] = [];
  const password = "fixture-password";
  const server = catalogServer({
    cwd,
    password,
    skillFile,
    urls,
    authorizations,
  });
  const baseUrl = await listen(server);
  const workerDataDir = join(homeDir, "worker-data");
  const harness = experimental_createHostEntryHarness(
    createOpenCodeHostEntry(),
    {
      experimental_paths: {
        dataDir: workerDataDir,
        tempDir: join(homeDir, "worker-temp"),
      },
    },
  );
  try {
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    vi.stubEnv("OPENCODE_CONFIG_DIR", undefined);
    vi.stubEnv("OPENCODE_SERVER_URL", baseUrl);
    vi.stubEnv("OPENCODE_SERVER_PASSWORD", password);
    vi.stubEnv("OPENCODE_APP", "shuvcode");
    const answer = await harness.experimental_call("resolveNativeRoots", {
      providerId: "opencode",
      cwd,
    });
    expect(urls).toEqual(
      expect.arrayContaining(["/api/info", "/api/skill", "/api/command"]),
    );
    expect(authorizations.every((value) => value !== undefined)).toBe(true);
    expect(answer.skills.map((root) => root.path)).toEqual([
      join(homeDir, ".config", "shuvcode", "skills"),
      skillFile,
    ]);
    const catalogDir = openCodeCommandCatalogDirectory({
      dataDir: workerDataDir,
      appId: "shuvcode",
      cwd,
    });
    expect(answer.commands.map((root) => root.path)).toEqual([catalogDir]);
    expect(readFileSync(join(catalogDir, "review.md"), "utf8")).toContain(
      'description: "Review the diff"',
    );
    await harness.experimental_dispose();
    expect(existsSync(catalogDir)).toBe(false);
  } finally {
    await harness.experimental_dispose();
    await closeServer(server);
  }
});

it("ignores the removed BB-prefixed OpenCode names in the host worker env", async () => {
  const cwd = join(homeDir, "proj");
  mkdirSync(cwd, { recursive: true });
  const urls: string[] = [];
  const authorizations: (string | undefined)[] = [];
  const password = "fixture-password";
  const server = catalogServer({
    cwd,
    password,
    skillFile: join(homeDir, "missing", "SKILL.md"),
    urls,
    authorizations,
  });
  const baseUrl = await listen(server);
  const harness = experimental_createHostEntryHarness(
    createOpenCodeHostEntry(),
    {
      experimental_paths: {
        dataDir: join(homeDir, "worker-data"),
        tempDir: join(homeDir, "worker-temp"),
      },
    },
  );
  try {
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("PATH", join(homeDir, "empty-bin"));
    vi.stubEnv("XDG_STATE_HOME", join(homeDir, "state"));
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    vi.stubEnv("OPENCODE_CONFIG_DIR", undefined);
    vi.stubEnv("OPENCODE_SERVER_URL", undefined);
    vi.stubEnv("OPENCODE_SERVER_PASSWORD", undefined);
    vi.stubEnv("OPENCODE_APP", undefined);
    vi.stubEnv("BB_OPENCODE_SERVER", baseUrl);
    vi.stubEnv("BB_OPENCODE_PASSWORD", password);
    vi.stubEnv("BB_OPENCODE_APP", "shuvcode");
    const answer = await harness.experimental_call("resolveNativeRoots", {
      providerId: "opencode",
      cwd,
    });
    expect(urls).toEqual([]);
    expect(answer.skills.map((root) => root.path)).toEqual([
      join(homeDir, ".config", "opencode", "skills"),
    ]);
    expect(answer.commands.map((root) => root.path)).toEqual([
      join(homeDir, ".config", "opencode", "commands"),
      join(homeDir, ".config", "opencode", "command"),
    ]);
  } finally {
    await harness.experimental_dispose();
    await closeServer(server);
  }
});
