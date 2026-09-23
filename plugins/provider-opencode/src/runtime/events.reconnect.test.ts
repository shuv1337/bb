import { describe, expect, it } from "vitest";
import { EventPump } from "./events.js";
import type { RuntimeSessionEvent } from "./types.js";

function labelOf(event: RuntimeSessionEvent): string {
  if (event.kind === "native") return event.event.type;
  if (event.kind === "resync") return event.reason;
  return event.kind;
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function recordingSleep(limit: number, onLimit: () => void) {
  const waits: number[] = [];
  const signals: AbortSignal[] = [];
  const sleep = async (ms: number, signal: AbortSignal): Promise<void> => {
    waits.push(ms);
    signals.push(signal);
    if (waits.length >= limit) {
      onLimit();
      await untilAborted(signal);
    }
  };
  return { waits, signals, sleep };
}

describe("EventPump reconnect", () => {
  it("emits resync only after the replacement stream is ready", async () => {
    let generation = 0;
    const pump = new EventPump(async function* (signal) {
      generation += 1;
      yield { type: "server.connected", data: {} };
      if (generation === 1) return;
      yield {
        type: "session.inbox.enqueued",
        data: { sessionID: "ses_a", inboxID: "msg_1" },
      };
      await untilAborted(signal);
    });
    const ac = new AbortController();
    const kinds: string[] = [];
    const consume = (async () => {
      for await (const event of pump.subscribe("ses_a", ac.signal)) {
        kinds.push(labelOf(event));
        if (kinds.includes("session.inbox.enqueued")) break;
      }
    })();
    await pump.ensureRunning();
    await consume;
    ac.abort();
    await pump.close();
    expect(kinds).toEqual([
      "stream.error",
      "reconnect",
      "session.inbox.enqueued",
    ]);
  });

  it("reports a stream that ends cleanly as a disconnect", async () => {
    let generation = 0;
    let reachedBackoff = (): void => {};
    const backoff = new Promise<void>((resolve) => {
      reachedBackoff = resolve;
    });
    const clock = recordingSleep(1, () => reachedBackoff());
    const pump = new EventPump(
      async function* () {
        generation += 1;
        yield { type: "server.connected", data: {} };
      },
      { sleep: clock.sleep },
    );
    const ac = new AbortController();
    const iterator = pump.subscribe("ses_a", ac.signal)[Symbol.asyncIterator]();
    try {
      await pump.ensureRunning();
      await backoff;
      expect(generation).toBe(1);
      expect(pump.isConnected).toBe(false);
      expect(pump.lastDisconnectError).toBeInstanceOf(Error);
      expect((await iterator.next()).value).toEqual({
        kind: "stream.error",
        sessionID: "ses_a",
        message: "OpenCode event stream ended",
      });
    } finally {
      ac.abort();
      await pump.close();
    }
  });

  it("keeps reconnecting after a transient error before server.connected", async () => {
    let generation = 0;
    const pump = new EventPump(async function* (signal) {
      generation += 1;
      if (generation === 2) throw new Error("connection refused");
      yield { type: "server.connected", data: {} };
      if (generation === 1) return;
      yield {
        type: "session.inbox.enqueued",
        data: { sessionID: "ses_a", inboxID: "msg_1" },
      };
      await untilAborted(signal);
    });
    const ac = new AbortController();
    const kinds: string[] = [];
    const consume = (async () => {
      for await (const event of pump.subscribe("ses_a", ac.signal)) {
        kinds.push(labelOf(event));
        if (kinds.includes("session.inbox.enqueued")) break;
      }
    })();
    try {
      await pump.ensureRunning();
      await consume;
      expect(generation).toBe(3);
      expect(kinds).toEqual([
        "stream.error",
        "reconnect",
        "session.inbox.enqueued",
      ]);
    } finally {
      ac.abort();
      await pump.close();
    }
  });

  it("rejects a first connect that fails transiently and connects on retry", async () => {
    let generation = 0;
    const pump = new EventPump(async function* (signal) {
      generation += 1;
      if (generation === 1) throw new Error("connection refused");
      yield { type: "server.connected", data: {} };
      await untilAborted(signal);
    });
    try {
      await expect(pump.ensureRunning()).rejects.toThrow("connection refused");
      await pump.ensureRunning();
      expect(pump.isConnected).toBe(true);
    } finally {
      await pump.close();
    }
  });

  it("fails a reconnect that errors fatally before the next server.connected", async () => {
    let generation = 0;
    const pump = new EventPump(
      async function* () {
        generation += 1;
        if (generation > 1) throw new Error("reconnect unauthorized");
        yield { type: "server.connected", data: {} };
      },
      {
        isFatal: (error) =>
          error instanceof Error && error.message === "reconnect unauthorized",
        sleep: async () => undefined,
      },
    );
    const ac = new AbortController();
    const iterator = pump.subscribe("ses_a", ac.signal)[Symbol.asyncIterator]();
    try {
      await pump.ensureRunning();
      const stoppedError = await pump.whenStopped().then(
        () => null,
        (error: unknown) => error,
      );
      expect(stoppedError).toBeInstanceOf(Error);
      if (!(stoppedError instanceof Error)) {
        throw new Error("expected reconnect failure");
      }
      expect(stoppedError.message).toBe("reconnect unauthorized");
      expect((await iterator.next()).value).toMatchObject({
        kind: "stream.error",
      });
      pump.fail(stoppedError);
      await expect(iterator.next()).rejects.toBe(stoppedError);
    } finally {
      ac.abort();
      await pump.close();
    }
  });

  it("aborts the pending backoff wait on close", async () => {
    let reachedBackoff = (): void => {};
    const backoff = new Promise<void>((resolve) => {
      reachedBackoff = resolve;
    });
    const clock = recordingSleep(1, () => reachedBackoff());
    const pump = new EventPump(
      async function* () {
        yield { type: "server.connected", data: {} };
      },
      { sleep: clock.sleep },
    );
    await pump.ensureRunning();
    await backoff;
    expect(clock.signals[0]?.aborted).toBe(false);
    await pump.close();
    expect(clock.signals[0]?.aborted).toBe(true);
  });

  it("climbs the backoff ladder when connections drop right after one event", async () => {
    let stop = (): void => {};
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const clock = recordingSleep(8, () => stop());
    const pump = new EventPump(
      async function* () {
        yield { type: "server.connected", data: {} };
        yield {
          type: "session.inbox.enqueued",
          data: { sessionID: "ses_a", inboxID: "msg_1" },
        };
      },
      { sleep: clock.sleep, now: () => 1_000 },
    );
    await pump.ensureRunning();
    await stopped;
    await pump.close();
    expect(clock.waits).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  });

  it("resets the backoff after a connection that stayed up", async () => {
    let stop = (): void => {};
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const clock = recordingSleep(3, () => stop());
    let now = 0;
    const pump = new EventPump(
      async function* () {
        yield { type: "server.connected", data: {} };
        now += 10_000;
      },
      { sleep: clock.sleep, now: () => now },
    );
    await pump.ensureRunning();
    await stopped;
    await pump.close();
    expect(clock.waits).toEqual([250, 250, 250]);
  });

  it("reports one stream.error per outage and clears it after reconnecting", async () => {
    let generation = 0;
    const pump = new EventPump(
      async function* (signal) {
        generation += 1;
        if (generation === 1) {
          yield { type: "server.connected", data: {} };
          throw new Error("socket hang up");
        }
        if (generation === 2) throw new Error("connection refused");
        yield { type: "server.connected", data: {} };
        await untilAborted(signal);
      },
      {
        sleep: async () => undefined,
        describeError: (error) =>
          `described: ${error instanceof Error ? error.message : "?"}`,
      },
    );
    const ac = new AbortController();
    const collect = async (): Promise<RuntimeSessionEvent[]> => {
      const seen: RuntimeSessionEvent[] = [];
      for await (const event of pump.subscribe("ses_a", ac.signal)) {
        seen.push(event);
        if (event.kind === "resync") break;
      }
      return seen;
    };
    const first = collect();
    const second = collect();
    try {
      await pump.ensureRunning();
      const expected = [
        {
          kind: "stream.error",
          sessionID: "ses_a",
          message: "described: socket hang up",
        },
        { kind: "resync", sessionID: "ses_a", reason: "reconnect" },
      ];
      expect(await first).toEqual(expected);
      expect(await second).toEqual(expected);
      expect(pump.lastDisconnectError).toBeNull();
    } finally {
      ac.abort();
      await pump.close();
    }
  });

  it("removes a connect waiter that timed out", async () => {
    const pump = new EventPump(
      async function* (signal) {
        await untilAborted(signal);
      },
      { connectTimeoutMs: 1 },
    );
    try {
      await expect(pump.ensureRunning()).rejects.toThrow(
        "OpenCode event stream did not become ready",
      );
      expect(pump.pendingConnectWaiters).toBe(0);
    } finally {
      await pump.close();
    }
  });

  it("moves live subscribers to a replacement pump and resyncs them there", async () => {
    const previous = new EventPump(async function* (signal) {
      yield { type: "server.connected", data: {} };
      yield {
        type: "session.created",
        data: { id: "ses_child", parentID: "ses_a" },
      };
      await untilAborted(signal);
    });
    let release = (): void => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = new EventPump(async function* (signal) {
      yield { type: "server.connected", data: {} };
      await released;
      yield { type: "session.tool.called", data: { sessionID: "ses_child" } };
      await untilAborted(signal);
    });
    const ac = new AbortController();
    const iterator = previous.subscribe("ses_a", ac.signal)[Symbol.asyncIterator]();
    try {
      await previous.ensureRunning();
      const created = await iterator.next();
      expect(created.value).toMatchObject({ kind: "native" });
      expect(next.adoptSubscribers(previous)).toBe(1);
      await previous.close();
      await next.ensureRunning();
      expect((await iterator.next()).value).toEqual({
        kind: "resync",
        sessionID: "ses_a",
        reason: "reconnect",
      });
      release();
      const tool = await iterator.next();
      expect(tool.value).toMatchObject({
        kind: "native",
        sessionID: "ses_child",
        parentID: "ses_a",
      });
      ac.abort();
      expect(await iterator.next()).toEqual({ value: undefined, done: true });
      const third = new EventPump(async function* () {});
      expect(third.adoptSubscribers(next)).toBe(0);
      await third.close();
    } finally {
      ac.abort();
      await previous.close();
      await next.close();
    }
  });
});
