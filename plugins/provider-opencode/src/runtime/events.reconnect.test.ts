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
