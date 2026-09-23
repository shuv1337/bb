import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenCodeRuntime } from "./index.js";
import { startOpenCodeBridgeHarness } from "../bridge/test-support.js";
import {
  OpenCodeUnauthenticatedError,
  OpenCodeUnknownCheckpointError,
} from "./errors.js";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function empty(res: ServerResponse, status: number): void {
  res.statusCode = status;
  res.end();
}

async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

type CapturedRequest = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
};

const FIXTURE_AGENTS = [
  {
    id: "build",
    name: "Build",
    mode: "primary",
    hidden: false,
    description: "Builds things",
    request: {},
    permissions: [],
  },
  {
    id: "plan",
    name: "Plan",
    mode: "primary",
    hidden: false,
    request: {},
    permissions: [],
  },
  {
    id: "explore",
    name: "Explore",
    mode: "subagent",
    hidden: true,
    request: {},
    permissions: [],
  },
];

async function startFixture(input?: {
  password?: string;
  dropSse?: number;
  bareUnauthorized?: boolean;
  unauthorizedEvents?: boolean;
  unauthorizedAfterConnect?: boolean;
  unavailableOnce?: boolean;
  notFoundAfterConnect?: boolean;
  failEnvironment?: boolean;
}) {
  const password = input?.password ?? "pw";
  const expectedAuth =
    "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const requests: CapturedRequest[] = [];
  const sessions = new Map<
    string,
    {
      id: string;
      title?: string;
      location: { directory: string };
      messages: Array<Record<string, unknown>>;
      env?: Record<string, string>;
      instructions?: Record<string, unknown>;
    }
  >();
  let sse: ServerResponse | null = null;
  let eventConnections = 0;
  let droppedSse = 0;
  const state = { pid: 4242, infoStatus: 200 };
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    const captured: CapturedRequest = {
      method,
      url,
      headers: { ...req.headers },
      body: "",
    };
    requests.push(captured);
    const auth = req.headers.authorization;
    if (auth !== expectedAuth) {
      res.statusCode = 401;
      res.end();
      return;
    }
    if (
      input?.bareUnauthorized &&
      !(method === "GET" && url.startsWith("/api/info"))
    ) {
      res.statusCode = 401;
      res.end();
      return;
    }
    if (
      input?.unauthorizedEvents &&
      method === "GET" &&
      url.startsWith("/api/event")
    ) {
      res.statusCode = 401;
      res.end();
      return;
    }
    if (
      input?.unauthorizedAfterConnect &&
      method === "GET" &&
      url.startsWith("/api/event")
    ) {
      eventConnections += 1;
      if (eventConnections > 1) {
        res.statusCode = 401;
        res.end();
        return;
      }
    }
    if (
      input?.notFoundAfterConnect &&
      method === "GET" &&
      url.startsWith("/api/event")
    ) {
      eventConnections += 1;
      if (eventConnections > 1) {
        json(res, 404, { _tag: "NotFound", message: "no event route" });
        return;
      }
    }
    let dropAfterConnect = false;
    if (input?.unavailableOnce && method === "GET" && url.startsWith("/api/event")) {
      eventConnections += 1;
      if (eventConnections === 2) {
        json(res, 503, { _tag: "Unavailable", message: "restarting" });
        return;
      }
      dropAfterConnect = eventConnections === 1;
    }
    void (async () => {
      if (method !== "GET") captured.body = await readText(req);
      if (method === "GET" && url.startsWith("/api/info")) {
        if (state.infoStatus !== 200) {
          empty(res, state.infoStatus);
          return;
        }
        json(res, 200, {
          version: "2.0.10",
          pid: state.pid,
          urls: [],
          paths: { tmp: "/tmp" },
        });
        return;
      }
      if (method === "GET" && url.startsWith("/api/event")) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.write(
          `data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`,
        );
        const dropThis = droppedSse < (input?.dropSse ?? 0);
        if (dropThis) droppedSse += 1;
        if (
          dropThis ||
          input?.unauthorizedAfterConnect ||
          input?.notFoundAfterConnect ||
          dropAfterConnect
        ) {
          res.end();
          return;
        }
        sse = res;
        req.on("close", () => {
          if (sse === res) sse = null;
        });
        return;
      }
      if (method === "GET" && url.startsWith("/api/model/default")) {
        json(res, 200, {
          location: { directory: "/workspace" },
          data: {
            id: "gemini-3.7-flash-high",
            modelID: "gemini-3.7-flash-high",
            providerID: "google",
            name: "Gemini",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            variants: [],
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 100, output: 20 },
          },
        });
        return;
      }
      if (method === "GET" && url.startsWith("/api/model")) {
        json(res, 200, {
          location: { directory: "/workspace" },
          data: [
            {
              id: "gemini-3.7-flash-high",
              modelID: "gemini-3.7-flash-high",
              providerID: "google",
              name: "Gemini",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              variants: [],
              time: { released: 0 },
              cost: [],
              status: "active",
              enabled: true,
              limit: { context: 100, output: 20 },
            },
            {
              id: "off",
              modelID: "off",
              providerID: "google",
              name: "Off",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              variants: [],
              time: { released: 0 },
              cost: [],
              status: "active",
              enabled: false,
              limit: { context: 1, output: 1 },
            },
          ],
        });
        return;
      }
      const body = captured.body ? JSON.parse(captured.body) : undefined;
      calls.push({ method, url, body });
      const listed = /^\/api\/(agent|config|skill|command)\?/.exec(url);
      if (method === "GET" && listed) {
        const location = { directory: "/workspace" };
        if (listed[1] === "agent") {
          json(res, 200, { location, data: FIXTURE_AGENTS });
          return;
        }
        if (listed[1] === "config") {
          json(res, 200, [
            { type: "document", path: "/workspace/opencode.json", info: { default_agent: "plan" } },
          ]);
          return;
        }
        if (listed[1] === "skill") {
          json(res, 200, {
            location,
            data: [
              {
                id: "lint",
                name: "Lint",
                description: "Runs lint",
                path: "/workspace/.opencode/skills/lint/SKILL.md",
                content: "lint body",
              },
            ],
          });
          return;
        }
        json(res, 200, {
          location,
          data: [
            { name: "team/review", description: "Review a file" },
            { name: "ship" },
          ],
        });
        return;
      }
      if (method === "POST" && url === "/api/session") {
        const created = {
          id: "ses_test1",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
          title: (body as { title?: string }).title,
          location: (body as { location?: { directory: string } }).location ?? {
            directory: "/workspace",
          },
          metadata: (body as { metadata?: unknown }).metadata,
          permissions: (body as { permissions?: unknown }).permissions,
        };
        sessions.set(created.id, {
          id: created.id,
          title: created.title,
          location: created.location,
          messages: [],
        });
        json(res, 200, { data: created });
        return;
      }
      const sessionMatch = /^\/api\/session\/([^/]+)(.*)$/.exec(url);
      if (sessionMatch) {
        const sessionID = sessionMatch[1] ?? "";
        const rest = sessionMatch[2] ?? "";
        const session = sessions.get(sessionID);
        if (method === "DELETE" && rest === "") {
          sessions.delete(sessionID);
          empty(res, 204);
          return;
        }
        if (method === "PATCH" && rest === "") {
          const title =
            typeof body === "object" && body !== null ? Reflect.get(body, "title") : undefined;
          if (session && typeof title === "string") session.title = title;
          empty(res, 204);
          return;
        }
        if (method === "POST" && (rest === "/agent" || rest === "/model")) {
          empty(res, 204);
          return;
        }
        if (method === "POST" && /^\/form\/[^/]+\/reply$/.test(rest)) {
          empty(res, 204);
          return;
        }
        if (method === "DELETE" && /^\/form\/[^/]+$/.test(rest)) {
          empty(res, 204);
          return;
        }
        if (method === "GET" && rest === "" && session) {
          json(res, 200, {
            data: {
              id: session.id,
              title: session.title,
              location: session.location,
              cost: 0,
              tokens: {
                input: 3,
                output: 4,
                reasoning: 1,
                cache: { read: 0, write: 0 },
              },
              outcome: "succeeded",
            },
          });
          return;
        }
        if (method === "POST" && rest === "/prompt") {
          session?.messages.push({
            id: "msg_user",
            type: "user",
            text: (body as { text?: string }).text,
            files: (body as { files?: unknown }).files,
            skills: (body as { skills?: unknown }).skills,
          });
          json(res, 200, {
            data: {
              id: "msg_user",
              sessionID,
              type: "user",
              payload: body,
              delivery: "steer",
              time: { created: 1 },
            },
          });
          return;
        }
        if (method === "GET" && rest === "/context") {
          json(res, 200, {
            data: [
              { id: "msg_a", type: "user", text: "one" },
              { id: "msg_b", type: "user", text: "two" },
              {
                id: "msg_c",
                type: "assistant",
                finish: "stop",
                tokens: {
                  input: 1,
                  output: 2,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
                content: [
                  { type: "tool", state: { thoughtSignature: "nope", ok: true } },
                ],
              },
            ],
          });
          return;
        }
        if (method === "POST" && rest === "/fork") {
          const before = (body as { before?: string }).before;
          json(res, 200, {
            data: {
              id: "ses_forked",
              fork: {
                sessionID,
                boundary: before
                  ? { type: "before", messageID: before }
                  : undefined,
              },
              location: { directory: "/workspace" },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            },
          });
          return;
        }
        if (method === "PUT" && rest === "/environment" && input?.failEnvironment) {
          json(res, 500, { _tag: "InternalError", message: "environment rejected" });
          return;
        }
        if (method === "PUT" && rest === "/environment") {
          if (session) session.env = (body as { variables: Record<string, string> }).variables;
          empty(res, 204);
          return;
        }
        const instr = /^\/api\/experimental\/session\/[^/]+\/instructions\/entries\/([^/]+)$/.exec(
          url,
        );
        if (instr && method === "PUT") {
          empty(res, 204);
          return;
        }
        if (instr && method === "DELETE") {
          empty(res, 204);
          return;
        }
        if (method === "POST" && rest.endsWith("/reply") && rest.includes("/permission/")) {
          empty(res, 204);
          return;
        }
        if (method === "POST" && rest === "/command") {
          empty(res, 204);
          return;
        }
        if (method === "POST" && rest === "/interrupt") {
          json(res, 200, { data: {} });
          return;
        }
        if (method === "POST" && rest === "/compact") {
          json(res, 200, {
            data: {
              id: "msg_compact",
              sessionID,
              type: "compaction",
              payload: {},
              delivery: "steer",
              time: { created: 1 },
            },
          });
          return;
        }
      }
      if (url.startsWith("/api/experimental/session/") && url.includes("/instructions/entries/")) {
        if (method === "PUT" || method === "DELETE") {
          empty(res, 204);
          return;
        }
      }
      json(res, 404, { _tag: "NotFound", message: url });
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const url = `http://127.0.0.1:${address.port}`;
  servers.push({
    close: () =>
      new Promise((resolve, reject) => {
        sse?.end();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });
  return {
    url,
    calls,
    requests,
    expectedAuth,
    password,
    state,
    sessions,
    push(event: Record<string, unknown>) {
      if (sse === null) throw new Error("no event stream is attached");
      sse.write(`data: ${JSON.stringify(event)}\n\n`);
    },
  };
}

function drainRejections(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function explicitEnv(fixture: { url: string; password: string }) {
  return {
    OPENCODE_SERVER_URL: fixture.url,
    OPENCODE_SERVER_PASSWORD: fixture.password,
  };
}

describe("http runtime adapter", () => {
  it("attaches, waits for SSE, and round-trips critical operations", async () => {
    const fixture = await startFixture();
    const runtime = await createOpenCodeRuntime({
      env: {
        OPENCODE_SERVER_URL: fixture.url,
        OPENCODE_SERVER_PASSWORD: fixture.password,
      },
    });
    const health = await runtime.health();
    expect(health.status).toBe("ready");
    expect(health.url).toBe(fixture.url);

    const models = await runtime.models({ directory: "/workspace" });
    expect(models.map((model) => model.id)).toEqual(["gemini-3.7-flash-high"]);
    expect(models[0]?.isDefault).toBe(true);
    expect(models[0]?.limit?.context).toBe(100);

    const session = await runtime.createSession({
      location: { directory: "/workspace" },
      title: "t",
      permissionMode: "accept-edits",
      instructions: { mode: "append", text: "note" },
      environment: { A: "1" },
    });
    await session.prompt({
      text: "hi",
      files: [{ uri: "file:///workspace/a.txt", name: "a.txt" }],
      skills: [{ id: "m0-probe" }],
    });
    const context = await session.context();
    expect(context.map((message) => message.id)).toEqual(["msg_a", "msg_b", "msg_c"]);
    expect(context[2]?.finish).toBe("stop");
    const tool = context[2]?.content as Array<{ state: Record<string, unknown> }>;
    expect(tool[0]?.state.thoughtSignature).toBeUndefined();

    const forked = await session.fork("msg_b");
    expect(forked.id).toBe("ses_forked");
    await expect(session.fork("msg_missing")).rejects.toBeInstanceOf(
      OpenCodeUnknownCheckpointError,
    );

    await session.setInstructions({ mode: "append", text: "" });
    await session.setEnvironment({ B: "2" });
    await session.replyPermission("per_1", "once");
    await session.compact();
    await session.interrupt();
    const info = await session.info();
    expect(info.tokens?.output).toBe(4);
    expect(info.outcome).toBe("succeeded");

    const bodies = fixture.calls.map((call) => `${call.method} ${call.url}`);
    expect(bodies.some((line) => line.startsWith("POST /api/session"))).toBe(true);
    expect(bodies.some((line) => line.includes("/prompt"))).toBe(true);
    expect(bodies.some((line) => line.includes("/fork"))).toBe(true);
    expect(
      bodies.some((line) => line.includes("/instructions/entries/bb.instructions")),
    ).toBe(true);

    await runtime.close();
    await expect(session.prompt({ text: "nope" })).rejects.toThrow(/closed/);
  });

  it("sends a command with its files, skills, and delivery", async () => {
    const fixture = await startFixture();
    const runtime = await createOpenCodeRuntime({ env: explicitEnv(fixture) });
    expect((await runtime.health()).status).toBe("ready");
    const session = await runtime.createSession({
      location: { directory: "/workspace" },
    });
    await session.command({
      name: "team/review",
      text: "src/a.ts",
      files: [{ uri: "file:///workspace/notes.md", name: "notes.md" }],
      skills: [{ id: "lint" }],
      delivery: "queue",
    });
    expect(
      fixture.calls.filter((call) => call.url === "/api/session/ses_test1/command"),
    ).toEqual([
      {
        method: "POST",
        url: "/api/session/ses_test1/command",
        body: {
          name: "team/review",
          text: "src/a.ts",
          files: [{ uri: "file:///workspace/notes.md", name: "notes.md" }],
          skills: [{ id: "lint" }],
          delivery: "queue",
        },
      },
    ]);
    await runtime.close();
  });

  it("sends the password only in the Authorization header", async () => {
    const fixture = await startFixture({ password: "fixture-pw-7f3a" });
    const token = Buffer.from(`opencode:${fixture.password}`).toString("base64");
    const runtime = await createOpenCodeRuntime({ env: explicitEnv(fixture) });
    const ac = new AbortController();
    try {
      expect((await runtime.health()).status).toBe("ready");
      await runtime.models({ directory: "/workspace" });
      await runtime.agents({ directory: "/workspace" });
      await runtime.skills({ directory: "/workspace" });
      await runtime.commands({ directory: "/workspace" });
      const iterator = runtime.subscribe("ses_test1", ac.signal)[Symbol.asyncIterator]();
      const session = await runtime.createSession({
        location: { directory: "/workspace" },
        title: "t",
        permissionMode: "accept-edits",
        instructions: { mode: "append", text: "note" },
        environment: { A: "1" },
      });
      await session.prompt({ text: "hi" });
      await session.command({ name: "ship", text: "" });
      await session.switchAgent("plan");
      await session.switchModel({ providerID: "google", id: "gemini-3.7-flash-high" });
      await session.update({ title: "renamed" });
      await session.replyForm("frm_1", { name: "x" });
      await session.cancelForm("frm_2");
      await session.replyPermission("per_1", "once");
      await session.info();
      await session.context();
      await session.compact();
      await session.interrupt();
      await session.setInstructions({ mode: "append", text: "" });
      await session.fork();
      await runtime.openSession("ses_test1");
      fixture.push({
        type: "session.inbox.enqueued",
        data: { sessionID: "ses_test1", inboxID: "msg_1" },
      });
      expect((await iterator.next()).value).toMatchObject({ kind: "native" });
    } finally {
      ac.abort();
      await runtime.close();
    }
    const paths = new Set(
      fixture.requests.map((request) => `${request.method} ${request.url.split("?")[0]}`),
    );
    expect([...paths]).toEqual(
      expect.arrayContaining([
        "GET /api/info",
        "GET /api/event",
        "GET /api/model",
        "GET /api/agent",
        "GET /api/skill",
        "GET /api/command",
        "GET /api/config",
        "POST /api/session",
        "GET /api/session/ses_test1",
        "PATCH /api/session/ses_test1",
        "PUT /api/session/ses_test1/environment",
        "PUT /api/experimental/session/ses_test1/instructions/entries/bb.instructions",
        "DELETE /api/experimental/session/ses_test1/instructions/entries/bb.instructions",
        "POST /api/session/ses_test1/prompt",
        "POST /api/session/ses_test1/command",
        "POST /api/session/ses_test1/agent",
        "POST /api/session/ses_test1/model",
        "POST /api/session/ses_test1/form/frm_1/reply",
        "DELETE /api/session/ses_test1/form/frm_2",
        "POST /api/session/ses_test1/permission/per_1/reply",
        "GET /api/session/ses_test1/context",
        "POST /api/session/ses_test1/compact",
        "POST /api/session/ses_test1/interrupt",
        "POST /api/session/ses_test1/fork",
      ]),
    );
    const leaks: string[] = [];
    for (const request of fixture.requests) {
      const where = `${request.method} ${request.url}`;
      if (request.headers.authorization !== fixture.expectedAuth) {
        leaks.push(`${where}: authorization ${String(request.headers.authorization)}`);
      }
      for (const [name, value] of Object.entries(request.headers)) {
        if (name === "authorization") continue;
        const text = Array.isArray(value) ? value.join(",") : String(value);
        if (text.includes(fixture.password) || text.includes(token)) {
          leaks.push(`${where}: header ${name}`);
        }
      }
      const url = decodeURIComponent(request.url);
      if (url.includes(fixture.password) || url.includes(token)) {
        leaks.push(`${where}: url`);
      }
      if (request.body.includes(fixture.password) || request.body.includes(token)) {
        leaks.push(`${where}: body`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("reconnects the event stream after the server drops it", async () => {
    const fixture = await startFixture({ dropSse: 1 });
    const runtime = await createOpenCodeRuntime({ env: explicitEnv(fixture) });
    const ac = new AbortController();
    try {
      const iterator = runtime.subscribe("ses_test1", ac.signal)[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({
        kind: "stream.error",
        sessionID: "ses_test1",
        message: "OpenCode event stream ended",
      });
      expect((await iterator.next()).value).toEqual({
        kind: "resync",
        sessionID: "ses_test1",
        reason: "reconnect",
      });
      fixture.push({
        type: "session.inbox.enqueued",
        data: { sessionID: "ses_test1", inboxID: "msg_after" },
      });
      expect((await iterator.next()).value).toMatchObject({
        kind: "native",
        sessionID: "ses_test1",
        event: {
          type: "session.inbox.enqueued",
          data: { sessionID: "ses_test1", inboxID: "msg_after" },
        },
      });
      expect(
        fixture.requests.filter(
          (request) => request.method === "GET" && request.url.startsWith("/api/event"),
        ),
      ).toHaveLength(2);
      expect((await runtime.health()).status).toBe("ready");
    } finally {
      ac.abort();
      await runtime.close();
    }
  });

  it("round-trips catalog and session operations over HTTP", async () => {
    const fixture = await startFixture();
    const runtime = await createOpenCodeRuntime({ env: explicitEnv(fixture) });
    try {
      const location = { directory: "/workspace" };
      const query = "?location%5Bdirectory%5D=%2Fworkspace";
      expect(await runtime.agents(location)).toEqual({
        agents: [
          {
            id: "build",
            name: "Build",
            mode: "primary",
            hidden: false,
            description: "Builds things",
          },
          { id: "plan", name: "Plan", mode: "primary", hidden: false, description: undefined },
          {
            id: "explore",
            name: "Explore",
            mode: "subagent",
            hidden: true,
            description: undefined,
          },
        ],
        defaultAgentId: "plan",
      });
      expect(await runtime.skills(location)).toEqual([
        {
          id: "lint",
          name: "Lint",
          description: "Runs lint",
          path: "/workspace/.opencode/skills/lint/SKILL.md",
        },
      ]);
      expect(await runtime.commands(location)).toEqual([
        { name: "team/review", description: "Review a file" },
        { name: "ship", description: undefined },
      ]);
      expect(fixture.calls).toEqual([
        { method: "GET", url: `/api/agent${query}`, body: undefined },
        { method: "GET", url: `/api/config${query}`, body: undefined },
        { method: "GET", url: `/api/skill${query}`, body: undefined },
        { method: "GET", url: `/api/command${query}`, body: undefined },
      ]);

      await runtime.createSession({ location, title: "t" });
      fixture.calls.length = 0;
      const session = await runtime.openSession("ses_test1");
      expect(session.id).toBe("ses_test1");
      await session.switchAgent("plan");
      await session.switchModel({ providerID: "google", id: "gemini-3.7-flash-high", variant: "high" });
      await session.update({
        title: "renamed",
        permissions: [{ action: "edit", resource: "*", effect: "ask" }],
      });
      await session.command({ name: "ship", text: "now" });
      await session.replyForm("frm_1", { name: "x", count: 2, ok: true, tags: ["a", "b"] });
      await session.cancelForm("frm_2");
      expect(fixture.calls).toEqual([
        { method: "GET", url: "/api/session/ses_test1", body: undefined },
        { method: "POST", url: "/api/session/ses_test1/agent", body: { agent: "plan" } },
        {
          method: "POST",
          url: "/api/session/ses_test1/model",
          body: {
            model: { id: "gemini-3.7-flash-high", providerID: "google", variant: "high" },
          },
        },
        {
          method: "PATCH",
          url: "/api/session/ses_test1",
          body: {
            title: "renamed",
            permissions: [{ action: "edit", resource: "*", effect: "ask" }],
          },
        },
        {
          method: "POST",
          url: "/api/session/ses_test1/command",
          body: { name: "ship", text: "now" },
        },
        {
          method: "POST",
          url: "/api/session/ses_test1/form/frm_1/reply",
          body: { answer: { name: "x", count: 2, ok: true, tags: ["a", "b"] } },
        },
        { method: "DELETE", url: "/api/session/ses_test1/form/frm_2", body: undefined },
      ]);
      expect(fixture.sessions.get("ses_test1")?.title).toBe("renamed");
    } finally {
      await runtime.close();
    }
  });

  it("does not attach to an OPENCODE_SERVER_URL on port 0 even when it answers", async () => {
    const fixture = await startFixture();
    const target = new URL(fixture.url);
    const runtime = await createOpenCodeRuntime({
      env: {
        OPENCODE_SERVER_URL: "http://127.0.0.1:0",
        OPENCODE_SERVER_PASSWORD: fixture.password,
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        url.port = target.port;
        return fetch(new Request(url, request));
      },
    });
    try {
      const health = await runtime.health();
      expect(health.status).toBe("unknown");
      expect(health.statusMessage).toBe("OpenCode service is not attached");
      await expect(
        runtime.createSession({ location: { directory: "/workspace" } }),
      ).rejects.toThrow(/not ready|not attached/i);
      expect(() => runtime.subscribe("ses_test1", new AbortController().signal)).toThrow(
        /not attached/,
      );
      expect(fixture.requests.length).toBeGreaterThan(0);
      expect(
        fixture.requests.filter((request) => request.url.split("?")[0] !== "/api/info"),
      ).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it("recovers bridge requests when the service starts after the first request", async () => {
    const fixture = await startFixture();
    let online = false;
    const runtime = await createOpenCodeRuntime({
      env: explicitEnv(fixture),
      fetch: async (input, init) => {
        if (!online) throw new Error("offline");
        return fetch(input, init);
      },
    });
    const bridge = await startOpenCodeBridgeHarness({
      wrapRuntime: () => runtime,
    });
    try {
      const offline = await bridge.request(101, "model/list", {
        cwd: "/workspace",
      });
      expect(offline.error).toBeDefined();
      online = true;
      const recovered = await bridge.request(102, "model/list", {
        cwd: "/workspace",
      });
      expect(recovered.error).toBeUndefined();
      expect(recovered.result).toMatchObject({
        models: [expect.objectContaining({ displayName: "Gemini" })],
      });
      expect((await bridge.startThread("late-service")).error).toBeUndefined();
    } finally {
      await bridge.teardown();
    }
  });

  it("rediscovers a restarted service through the same bridge", async () => {
    const previous = await startFixture();
    const next = await startFixture({ password: "rotated-fixture-password" });
    next.state.pid = 4343;
    const root = await mkdtemp(join(tmpdir(), "oc-bridge-recovery-"));
    const state = join(root, "state");
    await mkdir(join(state, "opencode"), { recursive: true });
    const registration = join(state, "opencode", "service.json");
    await writeFile(
      registration,
      JSON.stringify({
        url: previous.url,
        pid: 4242,
        password: previous.password,
      }),
    );
    const runtime = await createOpenCodeRuntime({
      env: { XDG_STATE_HOME: state },
      homedir: root,
      kill: (pid) => pid === 4242 || pid === 4343,
      which: () => undefined,
    });
    const bridge = await startOpenCodeBridgeHarness({
      wrapRuntime: () => runtime,
    });
    try {
      expect(
        (await bridge.request(101, "model/list", { cwd: "/workspace" })).error,
      ).toBeUndefined();
      previous.state.infoStatus = 503;
      await writeFile(
        registration,
        JSON.stringify({ url: next.url, pid: 4343, password: next.password }),
      );
      const recovered = await bridge.request(102, "model/list", {
        cwd: "/workspace",
      });
      expect(recovered.error).toBeUndefined();
      expect(
        next.requests.some((request) => request.url.startsWith("/api/model")),
      ).toBe(true);
      expect(
        (await bridge.startThread("restarted-service")).error,
      ).toBeUndefined();
    } finally {
      await bridge.teardown();
    }
  });

  it("attaches after a later health() once the server appears", async () => {
    const fixture = await startFixture();
    let online = false;
    const runtime = await createOpenCodeRuntime({
      env: explicitEnv(fixture),
      fetch: async (input, init) => {
        if (!online) throw new Error("offline");
        return fetch(input, init);
      },
    });
    const ac = new AbortController();
    try {
      const offline = await runtime.health();
      expect(offline.status).toBe("unknown");
      expect(offline.statusMessage).toMatch(/did not answer/);
      await expect(
        runtime.createSession({ location: { directory: "/workspace" } }),
      ).rejects.toThrow(/did not answer|not ready|not attached/i);
      expect(fixture.requests).toEqual([]);
      online = true;
      const health = await runtime.health();
      expect(health.status).toBe("ready");
      expect(health.pid).toBe(4242);
      const iterator = runtime.subscribe("ses_test1", ac.signal)[Symbol.asyncIterator]();
      const session = await runtime.createSession({ location: { directory: "/workspace" } });
      await session.prompt({ text: "after attach" });
      expect(fixture.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        "POST /api/session",
        "POST /api/session/ses_test1/prompt",
      ]);
      fixture.push({
        type: "session.inbox.enqueued",
        data: { sessionID: "ses_test1", inboxID: "msg_late" },
      });
      expect((await iterator.next()).value).toMatchObject({
        kind: "native",
        event: { type: "session.inbox.enqueued" },
      });
    } finally {
      ac.abort();
      await runtime.close();
    }
  });

  it("classifies a bare 401 and keeps the cause", async () => {
    const fixture = await startFixture({ bareUnauthorized: true });
    const runtime = await createOpenCodeRuntime({
      env: {
        OPENCODE_SERVER_URL: fixture.url,
        OPENCODE_SERVER_PASSWORD: fixture.password,
      },
    });
    let caught: unknown;
    try {
      await runtime.models({ directory: "/workspace" });
    } catch (error) {
      caught = error;
    } finally {
      await runtime.close();
    }
    expect(caught).toBeInstanceOf(OpenCodeUnauthenticatedError);
    if (!(caught instanceof OpenCodeUnauthenticatedError)) {
      throw new Error("expected OpenCodeUnauthenticatedError");
    }
    const statuses: unknown[] = [];
    let cause: unknown = caught.cause;
    while (typeof cause === "object" && cause !== null && statuses.length < 8) {
      statuses.push(Reflect.get(cause, "status"));
      cause = Reflect.get(cause, "cause");
    }
    expect(statuses).toContain(401);
  });

  it("does not classify a session id that contains 401", async () => {
    const fixture = await startFixture();
    const runtime = await createOpenCodeRuntime({
      env: {
        OPENCODE_SERVER_URL: fixture.url,
        OPENCODE_SERVER_PASSWORD: fixture.password,
      },
    });
    const sessionID = "ses_401abcd";
    let caught: unknown;
    try {
      await runtime.openSession(sessionID);
    } catch (error) {
      caught = error;
    } finally {
      await runtime.close();
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(OpenCodeUnauthenticatedError);
    if (!(caught instanceof Error)) {
      throw new Error("expected an Error");
    }
    expect(caught.message).toContain(sessionID);
  });

  it("rejects an unauthorized event stream without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const fixture = await startFixture({ unauthorizedEvents: true });
    const runtime = await createOpenCodeRuntime({
      env: {
        OPENCODE_SERVER_URL: fixture.url,
        OPENCODE_SERVER_PASSWORD: fixture.password,
      },
    });
    try {
      const ac = new AbortController();
      const first = runtime
        .subscribe("ses_test1", ac.signal)
        [Symbol.asyncIterator]()
        .next();
      const prompted = runtime
        .createSession({ location: { directory: "/workspace" }, title: "t" })
        .then((session) => session.prompt({ text: "hi" }));
      await expect(first).rejects.toBeInstanceOf(OpenCodeUnauthenticatedError);
      await expect(prompted).rejects.toBeInstanceOf(OpenCodeUnauthenticatedError);
      await expect(runtime.models({ directory: "/workspace" })).rejects.toThrow(
        /OpenCode rejected authentication/,
      );
      await drainRejections();
      expect(unhandled).toEqual([]);
    } finally {
      await runtime.close();
      await drainRejections();
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("rejects a reconnect that fails before the next server.connected and keeps that status", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const fixture = await startFixture({ unauthorizedAfterConnect: true });
    const runtime = await createOpenCodeRuntime({
      env: {
        OPENCODE_SERVER_URL: fixture.url,
        OPENCODE_SERVER_PASSWORD: fixture.password,
      },
    });
    try {
      const ac = new AbortController();
      const iterator = runtime
        .subscribe("ses_test1", ac.signal)
        [Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({
        kind: "stream.error",
        message: "OpenCode event stream ended",
      });
      await expect(iterator.next()).rejects.toBeInstanceOf(
        OpenCodeUnauthenticatedError,
      );
      const health = await runtime.health();
      expect(health.status).toBe("unauthenticated");
      await expect(runtime.models({ directory: "/workspace" })).rejects.toThrow(
        /OpenCode rejected authentication/,
      );
      expect((await runtime.health()).status).toBe("unauthenticated");
      await drainRejections();
      expect(unhandled).toEqual([]);
    } finally {
      await runtime.close();
      await drainRejections();
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("keeps the stream and ready status through a transient reconnect failure", async () => {
    const fixture = await startFixture({ unavailableOnce: true });
    const runtime = await createOpenCodeRuntime({
      env: {
        OPENCODE_SERVER_URL: fixture.url,
        OPENCODE_SERVER_PASSWORD: fixture.password,
      },
    });
    const ac = new AbortController();
    try {
      const iterator = runtime.subscribe("ses_test1", ac.signal)[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.value).toMatchObject({ kind: "stream.error", sessionID: "ses_test1" });
      const second = await iterator.next();
      expect(second.value).toMatchObject({ kind: "resync", reason: "reconnect" });
      expect((await runtime.health()).status).toBe("ready");
    } finally {
      ac.abort();
      await runtime.close();
    }
  });
  it("keeps live subscriptions when health() finds the service transiently gone", async () => {
    const fixture = await startFixture();
    const runtime = await createOpenCodeRuntime({ env: explicitEnv(fixture) });
    const ac = new AbortController();
    try {
      const iterator = runtime.subscribe("ses_test1", ac.signal)[Symbol.asyncIterator]();
      const session = await runtime.createSession({
        location: { directory: "/workspace" },
      });
      fixture.state.infoStatus = 503;
      expect((await runtime.health()).status).toBe("unknown");
      await session.prompt({ text: "still attached" });
      expect(
        fixture.calls.map((call) => `${call.method} ${call.url}`),
      ).toContain("POST /api/session/ses_test1/prompt");
      fixture.push({
        type: "session.inbox.enqueued",
        data: { sessionID: "ses_test1", inboxID: "msg_1" },
      });
      const next = await iterator.next();
      expect(next.done).toBe(false);
      expect(next.value).toMatchObject({
        kind: "native",
        event: { type: "session.inbox.enqueued" },
      });
      fixture.state.infoStatus = 200;
      expect((await runtime.health()).status).toBe("ready");
    } finally {
      ac.abort();
      await runtime.close();
    }
  });

  it("does not reattach a runtime that closed while health() was probing", async () => {
    const fixture = await startFixture();
    let gate: Promise<void> | null = null;
    let release = (): void => {};
    let probing = (): void => {};
    const probeStarted = new Promise<void>((resolve) => {
      probing = resolve;
    });
    const runtime = await createOpenCodeRuntime({
      env: explicitEnv(fixture),
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (gate !== null && url.endsWith("/api/info")) {
          probing();
          await gate;
        }
        return fetch(input, init);
      },
    });
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.state.pid = 4243;
    const pending = runtime.health();
    await probeStarted;
    await runtime.close();
    release();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it("moves subscriptions to the new stream when health() reattaches", async () => {
    const fixture = await startFixture();
    const runtime = await createOpenCodeRuntime({ env: explicitEnv(fixture) });
    const ac = new AbortController();
    try {
      const iterator = runtime.subscribe("ses_test1", ac.signal)[Symbol.asyncIterator]();
      await runtime.createSession({ location: { directory: "/workspace" } });
      fixture.state.pid = 4243;
      const health = await runtime.health();
      expect(health.status).toBe("ready");
      expect(health.pid).toBe(4243);
      const resync = await iterator.next();
      expect(resync.value).toEqual({
        kind: "resync",
        sessionID: "ses_test1",
        reason: "reconnect",
      });
      fixture.push({
        type: "session.inbox.enqueued",
        data: { sessionID: "ses_test1", inboxID: "msg_2" },
      });
      const next = await iterator.next();
      expect(next.value).toMatchObject({
        kind: "native",
        event: { type: "session.inbox.enqueued" },
      });
    } finally {
      ac.abort();
      await runtime.close();
    }
  });

  it("ends subscriptions with an error when health() finds rejected credentials", async () => {
    const fixture = await startFixture();
    const runtime = await createOpenCodeRuntime({ env: explicitEnv(fixture) });
    const ac = new AbortController();
    try {
      const iterator = runtime.subscribe("ses_test1", ac.signal)[Symbol.asyncIterator]();
      await runtime.createSession({ location: { directory: "/workspace" } });
      fixture.state.infoStatus = 401;
      expect((await runtime.health()).status).toBe("unauthenticated");
      await expect(iterator.next()).rejects.toBeInstanceOf(
        OpenCodeUnauthenticatedError,
      );
    } finally {
      ac.abort();
      await runtime.close();
    }
  });

  it("ends subscriptions with an error when the runtime closes", async () => {
    const fixture = await startFixture();
    const runtime = await createOpenCodeRuntime({ env: explicitEnv(fixture) });
    const ac = new AbortController();
    const iterator = runtime.subscribe("ses_test1", ac.signal)[Symbol.asyncIterator]();
    await runtime.createSession({ location: { directory: "/workspace" } });
    await runtime.close();
    await expect(iterator.next()).rejects.toThrow(/closed/);
  });

  it("reports a disconnected event stream through subscribers and health()", async () => {
    const fixture = await startFixture({ notFoundAfterConnect: true });
    const runtime = await createOpenCodeRuntime({ env: explicitEnv(fixture) });
    const ac = new AbortController();
    try {
      const iterator = runtime.subscribe("ses_test1", ac.signal)[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.value).toMatchObject({
        kind: "stream.error",
        sessionID: "ses_test1",
      });
      const health = await runtime.health();
      expect(health.status).toBe("unknown");
      expect(health.statusMessage).toMatch(/^OpenCode event stream disconnected: /);
    } finally {
      ac.abort();
      await runtime.close();
    }
  });

  it("removes the created session when post-create setup fails", async () => {
    const fixture = await startFixture({ failEnvironment: true });
    const runtime = await createOpenCodeRuntime({ env: explicitEnv(fixture) });
    try {
      await expect(
        runtime.createSession({
          location: { directory: "/workspace" },
          environment: { A: "1" },
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(
        fixture.calls.map((call) => `${call.method} ${call.url}`),
      ).toContain("DELETE /api/session/ses_test1");
      expect(fixture.sessions.has("ses_test1")).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it("reuses the attached registration in health() until it stops answering", async () => {
    const fixture = await startFixture();
    const root = await mkdtemp(join(tmpdir(), "oc-health-cache-"));
    const state = join(root, "state");
    await mkdir(join(state, "opencode"), { recursive: true });
    await writeFile(
      join(state, "opencode", "service.json"),
      JSON.stringify({ url: fixture.url, pid: 4242, password: fixture.password }),
    );
    let scans = 0;
    let versionProbes = 0;
    const runtime = await createOpenCodeRuntime({
      env: { XDG_STATE_HOME: state },
      homedir: root,
      kill: (pid) => pid === 4242,
      readdir: async (path) => {
        scans += 1;
        return readdir(path);
      },
      which: (command) => (command === "opencode" ? "/opt/bin/opencode" : undefined),
      execVersion: async () => {
        versionProbes += 1;
        return { stdout: "opencode v2.0.10", status: 0 };
      },
    });
    try {
      expect(scans).toBe(1);
      expect(versionProbes).toBe(1);
      expect((await runtime.health()).status).toBe("ready");
      expect((await runtime.health()).status).toBe("ready");
      expect(scans).toBe(1);
      expect(versionProbes).toBe(1);
      fixture.state.pid = 4343;
      expect((await runtime.health()).status).toBe("unknown");
      expect(scans).toBe(2);
      expect(versionProbes).toBe(2);
    } finally {
      await runtime.close();
    }
  });
});
