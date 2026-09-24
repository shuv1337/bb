import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { readCompanionStatus } from "./companion-status.js";
import { companionProbeSchema } from "./companion-status-contract.js";
import { createOpenCodeHostEntry } from "./host.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

function milestoneHello() {
  return {
    protocol: "bb.tools.v1",
    versions: { min: 1, max: 1 },
    package: { name: "opencode-bb-tools", version: "0.1.0" },
    install: { path: "/engines/opencode-bb-tools", digest: "digest-1" },
    generation: "gen",
    instances: 2,
    features: { richFailures: false },
    limits: {
      maxOutstandingCalls: 4,
      maxResultBytes: 2048,
      maxToolsPerBinding: 16,
      ownerLeaseMs: 30000,
      maxPendingWaitMs: 500,
    },
  };
}

describe("readCompanionStatus", () => {
  it("reads hello and the plugin list in URL mode without scanning the filesystem", async () => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      const url = req.url ?? "/";
      paths.push(url.split("?")[0] ?? url);
      res.setHeader("content-type", "application/json");
      if (url.startsWith("/api/info")) {
        res.end(JSON.stringify({ version: "2.0.15-shuv.2", pid: 9, urls: [], paths: { tmp: "/tmp" } }));
        return;
      }
      if (url.startsWith("/api/rpc/bb.tools.v1/hello")) {
        res.end(JSON.stringify({ output: milestoneHello() }));
        return;
      }
      if (url.startsWith("/api/plugin")) {
        res.end(
          JSON.stringify({
            location: { directory: "/engine" },
            data: [
              {
                id: "npm",
                source: { type: "package", target: "opencode-bb-tools" },
                features: { rpc: true },
                state: { status: "active" },
              },
              {
                id: "git",
                source: { type: "package", target: "github:shuv1337/opencode-bb-tools#v0.1.0" },
                features: { rpc: true },
                state: { status: "active" },
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
    const home = mkdtempSync(join(tmpdir(), "bb-companion-status-"));
    roots.push(home);
    const reads: string[] = [];
    try {
      const probe = await readCompanionStatus({
        env: { OPENCODE_SERVER_URL: baseUrl },
        homedir: home,
        readFile: async (path) => {
          reads.push(path);
          throw new Error(`filesystem read ${path}`);
        },
        readdir: async (path) => {
          reads.push(path);
          throw new Error(`filesystem scan ${path}`);
        },
      });
      expect(reads).toEqual([]);
      expect(paths).toEqual(expect.arrayContaining(["/api/info", "/api/rpc/bb.tools.v1/hello", "/api/plugin"]));
      expect(probe.detected).toBe(true);
      expect(probe.duplicates).toBe(true);
      expect(probe.engine.explicitServerUrl).toBe(true);
      expect(probe.engine.installCommand).toBe("shuvcode plugin add opencode-bb-tools");
      expect(probe.pluginSpecs).toHaveLength(2);
      expect(probe.instances).toBe(2);
    } finally {
      await closeServer(server);
    }
  });

  it("reports an unavailable companion instead of a transport failure", async () => {
    const server = createServer((req, res) => {
      const url = req.url ?? "/";
      res.setHeader("content-type", "application/json");
      if (url.startsWith("/api/info")) {
        res.end(JSON.stringify({ version: "2.0.15", pid: 3, urls: [], paths: { tmp: "/tmp" } }));
        return;
      }
      if (url.startsWith("/api/rpc/")) {
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            _tag: "RpcError",
            type: "rpc.unavailable",
            message: "RPC is unavailable: bb.tools.v1",
          }),
        );
        return;
      }
      if (url.startsWith("/api/plugin")) {
        res.end(JSON.stringify({ location: { directory: "/engine" }, data: [] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const baseUrl = await listen(server);
    try {
      const probe = await readCompanionStatus({
        env: { OPENCODE_SERVER_URL: baseUrl, OPENCODE_APP: "opencode" },
      });
      expect(probe.detected).toBe(false);
      expect(probe.reason).toContain("not installed");
      expect(probe.engine.installCommand).toBe("opencode plugin add opencode-bb-tools");
      expect(probe.package.version).toBeNull();
      expect(probe.instances).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it("serves the same probe from the host entry", async () => {
    const server = createServer((req, res) => {
      const url = req.url ?? "/";
      res.setHeader("content-type", "application/json");
      if (url.startsWith("/api/info")) {
        res.end(JSON.stringify({ version: "2.0.15", pid: 4, urls: [], paths: { tmp: "/tmp" } }));
        return;
      }
      if (url.startsWith("/api/rpc/")) {
        res.end(
          JSON.stringify({
            output: {
              protocol: "bb.tools.v1",
              version: 1,
              generation: "legacy",
              features: { richFailures: false },
            },
          }),
        );
        return;
      }
      if (url.startsWith("/api/plugin")) {
        res.end(JSON.stringify({ location: { directory: "/engine" }, data: [] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const baseUrl = await listen(server);
    const home = mkdtempSync(join(tmpdir(), "bb-companion-host-"));
    roots.push(home);
    vi.stubEnv("OPENCODE_SERVER_URL", baseUrl);
    vi.stubEnv("OPENCODE_APP", "opencode");
    vi.stubEnv("HOME", home);
    const harness = experimental_createHostEntryHarness(createOpenCodeHostEntry(), {
      experimental_paths: { dataDir: join(home, "data"), tempDir: join(home, "tmp") },
    });
    try {
      const probe = companionProbeSchema.parse(
        await harness.experimental_call("readCompanionStatus", {}),
      );
      expect(probe.detected).toBe(true);
      expect(probe.protocol.versions).toBeNull();
      expect(probe.protocol.legacyVersion).toBe(1);
      expect(probe.package.version).toBeNull();
      expect(probe.install.path).toBeNull();
      expect(probe.instances).toBeNull();
    } finally {
      await harness.experimental_dispose();
      await closeServer(server);
    }
  });
});
