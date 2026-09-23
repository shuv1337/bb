import { describe, expect, it } from "vitest";
import { EventPump, decodeNativeEvent, sessionIdOf } from "./events.js";
import { SUBSCRIBER_BUFFER_LIMIT } from "./types.js";
import type { RuntimeSessionEvent } from "./types.js";

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function scripted(events: readonly Record<string, unknown>[]) {
  let drained = (): void => {};
  const done = new Promise<void>((resolve) => {
    drained = resolve;
  });
  const pump = new EventPump(async function* (signal) {
    yield { type: "server.connected", data: {} };
    for (const event of events) yield event;
    drained();
    await untilAborted(signal);
  });
  return { pump, drained: done };
}

async function collect(
  events: AsyncIterable<RuntimeSessionEvent>,
): Promise<RuntimeSessionEvent[]> {
  const out: RuntimeSessionEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("EventPump", () => {
  it("routes child and grandchild events to the ancestor subscriber only", async () => {
    const { pump, drained } = scripted([
      {
        type: "session.created",
        data: { sessionID: "ses_child", parentID: "ses_parent" },
      },
      {
        type: "session.created",
        data: { id: "ses_grand", parentID: "ses_child" },
      },
      { type: "session.tool.called", data: { sessionID: "ses_grand" } },
      { type: "session.tool.called", data: { sessionID: "ses_other" } },
    ]);
    const ac = new AbortController();
    const parent = collect(pump.subscribe("ses_parent", ac.signal));
    const child = collect(pump.subscribe("ses_child", ac.signal));
    const unrelated = collect(pump.subscribe("ses_unrelated", ac.signal));
    await pump.ensureRunning();
    await drained;
    await pump.close();
    const routed = (events: RuntimeSessionEvent[]) =>
      events.map((event) =>
        event.kind === "native"
          ? `${event.event.type}:${event.sessionID}:${event.parentID ?? "-"}`
          : event.kind,
      );
    expect(routed(await parent)).toEqual([
      "session.created:ses_child:ses_parent",
      "session.created:ses_grand:ses_child",
      "session.tool.called:ses_grand:ses_child",
    ]);
    expect(routed(await child)).toEqual([
      "session.created:ses_child:ses_parent",
      "session.created:ses_grand:ses_child",
      "session.tool.called:ses_grand:ses_child",
    ]);
    expect(await unrelated).toEqual([]);
  });

  it("buffers a streaming turn without forcing an overflow resync", async () => {
    const count = 200;
    const events = Array.from({ length: count }, (_, index) => ({
      type: "session.text.delta",
      data: { sessionID: "ses_a", delta: String(index) },
    }));
    const { pump, drained } = scripted(events);
    const ac = new AbortController();
    const subscription = pump.subscribe("ses_a", ac.signal);
    await pump.ensureRunning();
    await drained;
    await pump.close();
    const seen = await collect(subscription);
    expect(seen.filter((event) => event.kind === "resync")).toEqual([]);
    expect(seen).toHaveLength(count);
  });

  it("replaces an overflowing buffer with one overflow resync", async () => {
    const events = Array.from({ length: SUBSCRIBER_BUFFER_LIMIT + 2 }, (_, index) => ({
      type: "session.text.delta",
      data: { sessionID: "ses_a", delta: String(index) },
    }));
    const { pump, drained } = scripted(events);
    const ac = new AbortController();
    const subscription = pump.subscribe("ses_a", ac.signal);
    await pump.ensureRunning();
    await drained;
    await pump.close();
    const seen = await collect(subscription);
    expect(seen[0]).toEqual({ kind: "resync", sessionID: "ses_a", reason: "overflow" });
    expect(seen).toHaveLength(2);
  });

  it("reads session.created id when sessionID is absent", () => {
    const event = decodeNativeEvent({
      type: "session.created",
      data: { id: "ses_from_id", parentID: "ses_parent" },
    });
    expect(event).not.toBeNull();
    expect(sessionIdOf(event!)).toBe("ses_from_id");
  });

  it("rejects vendor payloads without a type string", () => {
    expect(decodeNativeEvent({ data: {} })).toBeNull();
    expect(decodeNativeEvent({ type: "session.created" })?.type).toBe(
      "session.created",
    );
  });
});
