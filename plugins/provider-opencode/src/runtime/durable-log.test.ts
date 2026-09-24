import { expect, it } from "vitest";
import {
  collectDurableLog,
  DURABLE_LOG_MAX_EVENTS,
  DURABLE_LOG_MAX_PAGES,
  DURABLE_LOG_PAGE,
  parseDurableLogPage,
  type DurableLogPage,
} from "./http-runtime.js";
import type { OpenCodeNativeEvent } from "./types.js";

function filler(start: number, count: number): OpenCodeNativeEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "session.step.streamed",
    data: { sessionID: "ses_long" },
    durable: { seq: start + index },
  }));
}

function page(events: OpenCodeNativeEvent[], extra?: Partial<DurableLogPage>): DurableLogPage {
  const tail = events.at(-1)?.durable?.seq;
  return {
    events,
    synced: false,
    syncedSeq: undefined,
    truncated: events.length >= DURABLE_LOG_PAGE,
    lastSeq: typeof tail === "number" ? tail : undefined,
    ...extra,
  };
}

it("pages past 4096 events using the last durable sequence until log.synced", async () => {
  const calls: number[] = [];
  const read = await collectDurableLog(async (after) => {
    calls.push(after);
    if (after === 0) return page(filler(1, DURABLE_LOG_PAGE));
    return page(
      [
        {
          type: "session.step.started",
          data: { sessionID: "ses_long", assistantMessageID: "msg_tail" },
          durable: { seq: after + 1 },
        },
      ],
      { synced: true, syncedSeq: after + 1, truncated: false },
    );
  });
  expect(calls).toEqual([0, DURABLE_LOG_PAGE]);
  expect(read.complete).toBe(true);
  expect(read.events).toHaveLength(DURABLE_LOG_PAGE + 1);
  expect(read.events.at(-1)?.data?.assistantMessageID).toBe("msg_tail");
});

it("marks recovery incomplete when paging hits the bound before log.synced", async () => {
  let calls = 0;
  const read = await collectDurableLog(async (after) => {
    calls += 1;
    return page(filler(after + 1, DURABLE_LOG_PAGE));
  });
  expect(read.complete).toBe(false);
  expect(calls).toBeGreaterThan(1);
  expect(calls).toBeLessThanOrEqual(DURABLE_LOG_MAX_PAGES);
  expect(read.events.length).toBe(DURABLE_LOG_MAX_EVENTS);
});

it("keeps the last durable sequence when a page ends before log.synced", () => {
  const events = filler(1, DURABLE_LOG_PAGE);
  const raw = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const parsed = parseDurableLogPage(raw);
  expect(parsed.synced).toBe(false);
  expect(parsed.truncated).toBe(true);
  expect(parsed.lastSeq).toBe(DURABLE_LOG_PAGE);
  expect(parsed.events).toHaveLength(DURABLE_LOG_PAGE);
});
