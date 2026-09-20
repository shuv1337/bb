import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenCodeRuntime } from "./index.js";
import { OpenCodeUnknownCheckpointError } from "./errors.js";

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

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

async function startFixture(input?: { password?: string; dropSse?: boolean }) {
  const password = input?.password ?? "pw";
  const expectedAuth =
    "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  const calls: { method: string; url: string; body?: unknown }[] = [];
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
  const pid = 4242;
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    const auth = req.headers.authorization;
    if (auth !== expectedAuth) {
      res.statusCode = 401;
      res.end();
      return;
    }
    void (async () => {
      if (method === "GET" && url.startsWith("/api/info")) {
        json(res, 200, {
          version: "2.0.10",
          pid,
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
        if (input?.dropSse) {
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
      const body = method === "GET" ? undefined : await readBody(req);
      calls.push({ method, url, body });
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
  return { url, calls, password };
}

describe("http runtime adapter", () => {
  it("attaches, waits for SSE, and round-trips critical operations", async () => {
    const fixture = await startFixture();
    const runtime = await createOpenCodeRuntime({
      env: {
        BB_OPENCODE_SERVER: fixture.url,
        BB_OPENCODE_PASSWORD: fixture.password,
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
    expect(JSON.stringify(fixture.calls)).not.toContain("thoughtSignature");
    expect(JSON.stringify(fixture.calls)).not.toMatch(/password":/);

    await runtime.close();
    await expect(session.prompt({ text: "nope" })).rejects.toThrow(/closed/);
  });

  it("does not report ready on port 0 and can attach after a later health refresh", async () => {
    const runtime = await createOpenCodeRuntime({
      env: { BB_OPENCODE_SERVER: "http://127.0.0.1:1" },
      fetch: async () => {
        throw new Error("offline");
      },
    });
    expect((await runtime.health()).status).not.toBe("ready");
    await expect(
      runtime.createSession({ location: { directory: "/workspace" } }),
    ).rejects.toThrow(/not ready|not attached|did not answer/i);
    await runtime.close();
  });
});
