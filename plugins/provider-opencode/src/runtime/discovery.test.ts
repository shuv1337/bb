import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseAppIdFromVersion,
  parseVersionOutput,
  probeInfo,
  resolveAttachedRegistration,
  selectLiveRegistration,
} from "./discovery.js";
import { discoveryDepsFrom } from "./discovery.js";
import type { LiveRegistration } from "./discovery.js";

const servers: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

async function listen(
  handler: (
    req: { url?: string; headers: { authorization?: string } },
    res: {
      statusCode: number;
      setHeader: (k: string, v: string) => void;
      end: (b?: string) => void;
    },
  ) => void,
): Promise<{ url: string }> {
  const server = createServer((req, res) => {
    handler(
      { url: req.url, headers: req.headers as { authorization?: string } },
      res,
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no address");
  }
  servers.push({
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });
  return { url: `http://127.0.0.1:${address.port}` };
}

describe("discovery", () => {
  it("parses branded and bare version output", () => {
    expect(parseAppIdFromVersion("shuvcode v2.0.8\n")).toBe("shuvcode");
    expect(parseVersionOutput("1.18.31")).toEqual({
      appId: null,
      version: "1.18.31",
      isV1: true,
    });
    expect(parseVersionOutput("v2.0.11").isV1).toBe(false);
  });

  it("treats 401 as unauthenticated", async () => {
    const { url } = await listen((_req, res) => {
      res.statusCode = 401;
      res.end();
    });
    const result = await probeInfo(url, "secret", fetch);
    expect(result.unauthenticated).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("requires pid match for liveness", async () => {
    const { url } = await listen((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ version: "2.0.10", pid: 99, urls: [], paths: { tmp: "/t" } }));
    });
    const result = await probeInfo(url, "x", fetch);
    expect(result.ok).toBe(true);
    expect(result.pid).toBe(99);
  });

  it("selects requested app, then PATH app, then newest", () => {
    const live: LiveRegistration[] = [
      {
        appId: "opencode",
        file: "/a",
        url: "http://127.0.0.1:1",
        pid: 1,
        mtimeMs: 200,
      },
      {
        appId: "shuvcode",
        file: "/b",
        url: "http://127.0.0.1:2",
        pid: 2,
        mtimeMs: 100,
      },
      {
        appId: "shuvcode",
        file: "/c",
        url: "http://127.0.0.1:3",
        pid: 3,
        mtimeMs: 150,
      },
    ];
    expect(selectLiveRegistration(live, "shuvcode")?.file).toBe("/c");
    expect(selectLiveRegistration(live, "missing", "shuvcode")?.appId).toBe(
      "shuvcode",
    );
    expect(selectLiveRegistration(live, null)?.appId).toBe("opencode");
  });

  it("reports unauthenticated for explicit URL 401 without probing PATH", async () => {
    const { url } = await listen((_req, res) => {
      res.statusCode = 401;
      res.end();
    });
    const deps = discoveryDepsFrom({
      env: { BB_OPENCODE_SERVER: url, BB_OPENCODE_PASSWORD: "wrong" },
      which: () => {
        throw new Error("PATH should not be probed for explicit URL");
      },
      execVersion: async () => {
        throw new Error("PATH should not be probed for explicit URL");
      },
    });
    const attached = await resolveAttachedRegistration(deps);
    expect(attached.health.status).toBe("unauthenticated");
    expect(attached.health.pathBinaryAppId).toBeNull();
    expect(attached.registration).toBeNull();
  });

  it("reports unknown with app id for stale registrations even without PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "oc-stale-"));
    const state = join(root, "state");
    await mkdir(join(state, "shuvcode"), { recursive: true });
    await writeFile(
      join(state, "shuvcode", "service.json"),
      JSON.stringify({
        url: "http://127.0.0.1:9",
        pid: 99,
        version: "2.0.8",
      }),
    );
    const deps = discoveryDepsFrom({
      env: { XDG_STATE_HOME: state },
      homedir: root,
      kill: () => false,
      which: () => undefined,
      execVersion: async () => ({ stdout: "", status: 1 }),
    });
    const attached = await resolveAttachedRegistration(deps);
    expect(attached.health.status).toBe("unknown");
    expect(attached.health.appId).toBe("shuvcode");
    expect(attached.health.statusMessage).toContain("shuvcode serve --service");
  });

  it("uses the v2 binary when the first PATH binary is v1", async () => {
    const { url } = await listen((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          version: "2.0.8",
          pid: 4242,
          urls: [],
          paths: { tmp: "/t" },
        }),
      );
    });
    const root = await mkdtemp(join(tmpdir(), "oc-v1-"));
    const state = join(root, "state");
    await mkdir(join(state, "shuvcode"), { recursive: true });
    await writeFile(
      join(state, "shuvcode", "service.json"),
      JSON.stringify({
        url,
        pid: 4242,
        version: "2.0.8",
        password: "pw",
      }),
    );
    const deps = discoveryDepsFrom({
      env: { XDG_STATE_HOME: state },
      homedir: root,
      kill: (pid) => pid === 4242,
      which: (command) => (command === "opencode" || command === "shuvcode" ? command : undefined),
      execVersion: async (binary) =>
        binary === "opencode"
          ? { stdout: "1.18.31", status: 0 }
          : { stdout: "shuvcode v2.0.8", status: 0 },
    });
    const attached = await resolveAttachedRegistration(deps);
    expect(attached.health.status).toBe("ready");
    expect(attached.health.pathBinaryAppId).toBe("shuvcode");
    expect(attached.health.installedVersion).toBe("2.0.8");
  });

  it("reports unauthenticated for a live pid with a wrong registration password", async () => {
    const { url } = await listen((_req, res) => {
      res.statusCode = 401;
      res.end();
    });
    const root = await mkdtemp(join(tmpdir(), "oc-unauth-"));
    const state = join(root, "state");
    await mkdir(join(state, "shuvcode"), { recursive: true });
    await writeFile(
      join(state, "shuvcode", "service.json"),
      JSON.stringify({
        url,
        pid: 7,
        version: "2.0.8",
        password: "wrong",
      }),
    );
    const deps = discoveryDepsFrom({
      env: { XDG_STATE_HOME: state },
      homedir: root,
      kill: (pid) => pid === 7,
      which: () => undefined,
      execVersion: async () => ({ stdout: "", status: 1 }),
    });
    const attached = await resolveAttachedRegistration(deps);
    expect(attached.health.status).toBe("unauthenticated");
  });

  it("skips dead pid registrations and attaches to a live pid match", async () => {
    const { url } = await listen((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          version: "2.0.8",
          pid: 4242,
          urls: [],
          paths: { tmp: "/t" },
        }),
      );
    });
    const root = await mkdtemp(join(tmpdir(), "oc-disc-"));
    const state = join(root, "state");
    await mkdir(join(state, "opencode"), { recursive: true });
    await mkdir(join(state, "shuvcode"), { recursive: true });
    await writeFile(
      join(state, "opencode", "service-dead.json"),
      JSON.stringify({
        url: "http://127.0.0.1:9",
        pid: 1,
        version: "0.0.0-next-1",
      }),
    );
    await writeFile(
      join(state, "shuvcode", "service.json"),
      JSON.stringify({
        url,
        pid: 4242,
        version: "2.0.8",
        password: "pw",
      }),
    );
    const deps = discoveryDepsFrom({
      env: { XDG_STATE_HOME: state },
      homedir: root,
      kill: (pid) => pid === 4242,
      which: () => undefined,
      execVersion: async () => ({ stdout: "shuvcode v2.0.8", status: 0 }),
    });
    const attached = await resolveAttachedRegistration(deps);
    expect(attached.health.status).toBe("ready");
    expect(attached.health.appId).toBe("shuvcode");
    expect(attached.registration?.url).toBe(url);
  });
});
