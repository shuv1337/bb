import { createServer } from "node:http";
import { chmod, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isLoopbackUrl,
  parseAppIdFromVersion,
  parseVersionOutput,
  probeInfo,
  resolveAttachedRegistration,
  scanRegistrations,
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

function infoResponse(pid: number): Response {
  return new Response(
    JSON.stringify({ version: "2.0.10", pid, urls: [], paths: { tmp: "/t" } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function stateWith(
  registrations: Record<string, Record<string, unknown>>,
): Promise<{ root: string; state: string }> {
  const root = await mkdtemp(join(tmpdir(), "oc-scan-"));
  const state = join(root, "state");
  for (const [relative, body] of Object.entries(registrations)) {
    const file = join(state, relative);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(body));
  }
  return { root, state };
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
      env: { OPENCODE_SERVER_URL: url, OPENCODE_SERVER_PASSWORD: "wrong" },
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
  it("scans only the allowlisted state roots plus the requested app", async () => {
    const { url } = await listen((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ version: "2.0.8", pid: 4242, urls: [], paths: { tmp: "/t" } }));
    });
    const { root, state } = await stateWith({
      "evil/service.json": { url, pid: 4242, password: "pw" },
    });
    const base = {
      homedir: root,
      kill: (pid: number) => pid === 4242,
      which: () => undefined,
      execVersion: async () => ({ stdout: "", status: 1 }),
    };
    const unlisted = await resolveAttachedRegistration(
      discoveryDepsFrom({ ...base, env: { XDG_STATE_HOME: state } }),
    );
    expect(unlisted.registration).toBeNull();
    expect(unlisted.health.status).toBe("not_installed");
    const requested = await resolveAttachedRegistration(
      discoveryDepsFrom({
        ...base,
        env: { XDG_STATE_HOME: state, OPENCODE_APP: "evil" },
      }),
    );
    expect(requested.health.status).toBe("ready");
    expect(requested.registration?.appId).toBe("evil");
  });

  it("ignores symlinked state roots and symlinked registration files", async () => {
    const fetched: string[] = [];
    const outside = await stateWith({
      "elsewhere/service.json": { url: "http://127.0.0.1:7001", pid: 4242 },
      "loose.json": { url: "http://127.0.0.1:7002", pid: 4242 },
      "opencode/service.json": { url: "http://127.0.0.1:7003", pid: 4242 },
    });
    const { root, state } = await stateWith({});
    await mkdir(join(state, "shuvcode"), { recursive: true });
    await symlink(join(outside.state, "elsewhere"), join(state, "opencode"));
    await symlink(outside.state, join(state, "opencode-next"));
    await symlink(
      join(outside.state, "loose.json"),
      join(state, "shuvcode", "service.json"),
    );
    const candidates = await scanRegistrations(
      discoveryDepsFrom({
        env: { XDG_STATE_HOME: state },
        homedir: root,
        kill: () => true,
        fetch: async (input) => {
          fetched.push(String(input));
          return infoResponse(4242);
        },
      }),
    );
    expect(candidates).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it("never sends registration credentials to a non-loopback URL", async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const { root, state } = await stateWith({
      "opencode/service.json": {
        url: "http://10.20.30.40:4096",
        pid: 4242,
        password: "pw",
      },
    });
    const attached = await resolveAttachedRegistration(
      discoveryDepsFrom({
        env: { XDG_STATE_HOME: state },
        homedir: root,
        kill: () => true,
        which: () => undefined,
        execVersion: async () => ({ stdout: "", status: 1 }),
        localAddresses: () => ["127.0.0.1", "100.64.0.5"],
        fetch: async (input, init) => {
          requests.push({
            url: String(input),
            authorization: new Headers(init?.headers).get("authorization"),
          });
          return infoResponse(4242);
        },
      }),
    );
    expect(requests).toEqual([]);
    expect(attached.registration).toBeNull();
    expect(attached.health.status).toBe("unknown");
    expect(attached.health.statusMessage).toContain("OPENCODE_SERVER_URL");
    expect(isLoopbackUrl("http://127.0.0.1:4096")).toBe(true);
    expect(isLoopbackUrl("http://localhost:4096")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:4096")).toBe(true);
    expect(isLoopbackUrl("http://0.0.0.0:4096")).toBe(true);
    expect(isLoopbackUrl("http://[::ffff:127.0.0.1]:4096")).toBe(true);
    expect(isLoopbackUrl("http://[::ffff:10.0.0.1]:4096")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1.example.test:4096")).toBe(false);
    expect(isLoopbackUrl("file:///tmp/socket")).toBe(false);
  });

  it("attaches to a registration on one of this host's own interface addresses", async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const { root, state } = await stateWith({
      "opencode/service.json": {
        url: "http://100.64.0.5:4096",
        pid: 4242,
        password: "pw",
      },
    });
    const attached = await resolveAttachedRegistration(
      discoveryDepsFrom({
        env: { XDG_STATE_HOME: state },
        homedir: root,
        kill: () => true,
        which: () => undefined,
        execVersion: async () => ({ stdout: "", status: 1 }),
        localAddresses: () => ["127.0.0.1", "100.64.0.5"],
        fetch: async (input, init) => {
          requests.push({
            url: String(input),
            authorization: new Headers(init?.headers).get("authorization"),
          });
          return infoResponse(4242);
        },
      }),
    );
    expect(attached.health.status).toBe("ready");
    expect(attached.registration?.url).toBe("http://100.64.0.5:4096");
    expect(requests).toEqual([
      {
        url: "http://100.64.0.5:4096/api/info",
        authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}`,
      },
    ]);
  });

  it("attaches to the preferred live registration without waiting on a hung probe", async () => {
    const { root, state } = await stateWith({
      "opencode/service.json": { url: "http://127.0.0.1:7101", pid: 11 },
      "shuvcode/service.json": { url: "http://127.0.0.1:7102", pid: 22 },
    });
    let hungSignal: AbortSignal | undefined;
    let releaseHung = (): void => {};
    const hung = new Promise<Response>((resolve) => {
      releaseHung = () => resolve(infoResponse(11));
    });
    try {
      const attached = await resolveAttachedRegistration(
        discoveryDepsFrom({
          env: { XDG_STATE_HOME: state, OPENCODE_APP: "shuvcode" },
          homedir: root,
          kill: () => true,
          which: () => undefined,
          execVersion: async () => ({ stdout: "", status: 1 }),
          fetch: async (input, init) => {
            if (String(input).startsWith("http://127.0.0.1:7101")) {
              hungSignal = init?.signal ?? undefined;
              return hung;
            }
            return infoResponse(22);
          },
        }),
      );
      expect(attached.health.status).toBe("ready");
      expect(attached.registration?.url).toBe("http://127.0.0.1:7102");
      expect(hungSignal?.aborted).toBe(true);
    } finally {
      releaseHung();
    }
  });

  it("labels a registration without a usable url as a url failure", async () => {
    const { root, state } = await stateWith({
      "opencode/service-a.json": { pid: 5 },
      "opencode/service-b.json": { url: "http://127.0.0.1:1", pid: "5" },
      "opencode/service-c.json": { url: "not a url", pid: 5 },
    });
    const candidates = await scanRegistrations(
      discoveryDepsFrom({
        env: { XDG_STATE_HOME: state },
        homedir: root,
        kill: () => false,
      }),
    );
    const byFile = Object.fromEntries(
      candidates.map((candidate) => [
        candidate.file.slice(candidate.file.lastIndexOf("/") + 1),
        candidate.failure,
      ]),
    );
    expect(byFile).toEqual({
      "service-a.json": "url",
      "service-b.json": "pid",
      "service-c.json": "url",
    });
  });

  it("releases the response body when the info probe fails", async () => {
    const cancelled: number[] = [];
    const bodyFor = (status: number) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
        },
        cancel() {
          cancelled.push(status);
        },
      });
    for (const status of [401, 503]) {
      const result = await probeInfo("http://127.0.0.1:1", "pw", async () =>
        new Response(bodyFor(status), { status }),
      );
      expect(result.ok).toBe(false);
    }
    expect(cancelled).toEqual([401, 503]);
  });

  it("looks binaries up on the injected PATH only and skips directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "oc-which-"));
    const shadow = join(root, "shadow");
    const real = join(root, "real");
    await mkdir(join(shadow, "opencode"), { recursive: true });
    await mkdir(real, { recursive: true });
    const binary = join(real, "opencode");
    await writeFile(binary, "#!/bin/sh\necho \"opencode v$OPENCODE_FAKE_VERSION\"\n");
    await chmod(binary, 0o755);
    const deps = discoveryDepsFrom({
      env: { PATH: `${shadow}:${real}`, OPENCODE_FAKE_VERSION: "2.0.99" },
    });
    expect(deps.which("opencode")).toBe(binary);
    expect(discoveryDepsFrom({ env: {} }).which("sh")).toBeUndefined();
    const version = await deps.execVersion(binary);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe("opencode v2.0.99");
  });
});
