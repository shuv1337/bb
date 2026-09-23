import { describe, expect, it } from "vitest";
import { EventPump } from "./events.js";

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
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const ac = new AbortController();
    const kinds: string[] = [];
    const consume = (async () => {
      for await (const event of pump.subscribe("ses_a", ac.signal)) {
        kinds.push(event.kind === "native" ? event.event.type : event.reason);
        if (kinds.includes("session.inbox.enqueued")) break;
      }
    })();
    await pump.ensureRunning();
    await consume;
    ac.abort();
    await pump.close();
    expect(kinds).toContain("reconnect");
    expect(kinds).toContain("session.inbox.enqueued");
    expect(kinds.indexOf("reconnect")).toBeLessThan(
      kinds.indexOf("session.inbox.enqueued"),
    );
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
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const ac = new AbortController();
    const kinds: string[] = [];
    const consume = (async () => {
      for await (const event of pump.subscribe("ses_a", ac.signal)) {
        kinds.push(event.kind === "native" ? event.event.type : event.reason);
        if (kinds.includes("session.inbox.enqueued")) break;
      }
    })();
    try {
      await pump.ensureRunning();
      await consume;
      expect(generation).toBe(3);
      expect(kinds).toEqual(["reconnect", "session.inbox.enqueued"]);
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
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
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
      (error) => error instanceof Error && error.message === "reconnect unauthorized",
    );
    const ac = new AbortController();
    const iterator = pump.subscribe("ses_a", ac.signal)[Symbol.asyncIterator]();
    let stoppedError: unknown;
    const stopped = pump.whenStopped().then(
      () => "clean" as const,
      (error: unknown) => {
        stoppedError = error;
        return "failed" as const;
      },
    );
    const consumed = iterator.next().then(
      () => "value" as const,
      (error: unknown) => error,
    );
    try {
      await pump.ensureRunning();
      const outcome = await Promise.race([
        stopped,
        new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), 1_500);
        }),
      ]);
      expect(outcome).toBe("failed");
      expect(stoppedError).toBeInstanceOf(Error);
      if (!(stoppedError instanceof Error)) {
        throw new Error("expected reconnect failure");
      }
      expect(stoppedError.message).toBe("reconnect unauthorized");
      pump.fail(stoppedError);
      await expect(consumed).resolves.toBe(stoppedError);
    } finally {
      ac.abort();
      await pump.close();
    }
  });

  it("aborts pending backoff on close", async () => {
    const pump = new EventPump(async function* () {
      yield { type: "server.connected", data: {} };
    });
    await pump.ensureRunning();
    const started = Date.now();
    await pump.close();
    expect(Date.now() - started).toBeLessThan(200);
  });
});
