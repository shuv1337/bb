import { describe, expect, it } from "vitest";
import { OpenCodeInstructionReplaceError } from "./errors.js";
import { createFakeOpenCodeRuntime } from "./fake-runtime.js";

describe("createFakeOpenCodeRuntime", () => {
  it("rejects instruction replace and appends via setInstructions", async () => {
    const runtime = createFakeOpenCodeRuntime();
    const session = await runtime.createSession({
      location: { directory: "/tmp" },
    });
    await expect(
      session.setInstructions({ mode: "replace", text: "nope" }),
    ).rejects.toBeInstanceOf(OpenCodeInstructionReplaceError);
    const events: string[] = [];
    const ac = new AbortController();
    const consume = (async () => {
      for await (const event of runtime.subscribe(session.id, ac.signal)) {
        events.push(event.kind === "native" ? event.event.type : event.kind);
        if (event.kind === "native" && event.event.type === "session.inbox.enqueued") {
          break;
        }
      }
    })();
    await session.setInstructions({ mode: "append", text: "hello" });
    await session.prompt({ text: "hi" });
    await consume;
    ac.abort();
    expect(events).toContain("session.inbox.enqueued");
    await runtime.close();
  });

  it("forks inclusively by mapping the next message as before", async () => {
    const runtime = createFakeOpenCodeRuntime();
    const session = await runtime.createSession({
      location: { directory: "/tmp" },
    });
    await session.prompt({ text: "one" });
    await session.prompt({ text: "two" });
    const context = await session.context();
    const first = context[0];
    const second = context[1];
    if (first === undefined || second === undefined) {
      throw new Error("expected two messages");
    }
    const forked = await session.fork(first.id);
    const copied = await forked.context();
    expect(copied.map((message) => message.text)).toEqual(["one"]);
    const tip = await session.fork();
    expect((await tip.context()).map((message) => message.text)).toEqual([
      "one",
      "two",
    ]);
    await expect(session.fork("msg_missing")).rejects.toThrow(/Unknown checkpoint/);
    await runtime.close();
  });

  it("exposes defaultAgentId from config documents", async () => {
    const runtime = createFakeOpenCodeRuntime({
      configEntries: [{ type: "document", info: { default_agent: "plan" } }],
    });
    const catalog = await runtime.agents({ directory: "/tmp" });
    expect(catalog.defaultAgentId).toBe("plan");
    await runtime.close();
  });
});
