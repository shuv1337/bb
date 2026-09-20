import { describe, expect, it } from "vitest";
import { EventPump, decodeNativeEvent, sessionIdOf } from "./events.js";

describe("EventPump", () => {
  it("demuxes child and grandchild onto the parent subscriber", async () => {
    const pump = new EventPump(async function* (signal) {
      yield { type: "server.connected", data: {} };
      yield {
        type: "session.created",
        data: { sessionID: "ses_child", parentID: "ses_parent" },
      };
      yield {
        type: "session.created",
        data: { id: "ses_grand", parentID: "ses_child" },
      };
      yield {
        type: "session.tool.called",
        data: { sessionID: "ses_grand" },
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
    const seen: string[] = [];
    const consume = (async () => {
      for await (const event of pump.subscribe("ses_parent", ac.signal)) {
        if (event.kind === "native") seen.push(event.event.type);
        if (seen.filter((type) => type !== "server.connected").length >= 3) {
          break;
        }
      }
    })();
    await pump.ensureRunning();
    await consume;
    ac.abort();
    await pump.close();
    expect(seen).toContain("session.created");
    expect(seen).toContain("session.tool.called");
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
