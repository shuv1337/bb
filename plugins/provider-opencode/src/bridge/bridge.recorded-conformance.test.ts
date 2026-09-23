import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  experimental_checkRecordedCellReplay as checkRecordedCellReplay,
  experimental_createBridgeDeltaEventCollector as createBridgeDeltaEventCollector,
  type BridgeJsonRpcOutputMessage,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createOpenCodeDeltaTranslator } from "../delta-translation.js";
import type { OpenCodeNativeEvent } from "../runtime/index.js";
import {
  type OpenCodeBridgeHarness,
  startOpenCodeBridgeHarness,
} from "./test-support.js";

const CELLS = [
  "turn-tools",
  "user-question",
  "steer",
  "stop-interrupt",
  "fork",
  "resume",
  "compaction",
] as const;

type Cell = (typeof CELLS)[number];

const EXECUTION_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} as const;

const TERMINAL_NATIVE_TYPES = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.compaction.ended",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadFixture(name: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"),
  );
  if (!Array.isArray(parsed)) throw new Error(name);
  return parsed.map((entry) => {
    if (!isRecord(entry) || typeof entry.type !== "string")
      throw new Error(name);
    return entry;
  });
}

function mapValue(
  value: unknown,
  replacements: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") return replacements.get(value) ?? value;
  if (Array.isArray(value))
    return value.map((entry) => mapValue(entry, replacements));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      mapValue(entry, replacements),
    ]),
  );
}

function rewrite(
  event: Record<string, unknown>,
  replacements: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const mapped = mapValue(event, replacements);
  if (!isRecord(mapped) || typeof mapped.type !== "string") {
    throw new Error("rewritten event");
  }
  return mapped;
}

function sliceBetween(
  events: readonly Record<string, unknown>[],
  startType: string,
  endType: string,
  startOccurrence = 0,
): Record<string, unknown>[] {
  let seen = 0;
  let start = -1;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.type !== startType) continue;
    if (seen === startOccurrence) {
      start = index;
      break;
    }
    seen += 1;
  }
  const end = events.findIndex(
    (event, index) => index >= start && event.type === endType,
  );
  if (start < 0 || end < start) throw new Error(`${startType}..${endType}`);
  return events.slice(start, end + 1);
}

function providerThreadId(response: BridgeJsonRpcOutputMessage): string {
  const result = response.result;
  if (!isRecord(result) || typeof result.providerThreadId !== "string") {
    throw new Error("missing providerThreadId");
  }
  return result.providerThreadId;
}

function sessionOf(event: Record<string, unknown>): string | undefined {
  if (!isRecord(event.data)) return undefined;
  if (typeof event.data.sessionID === "string") return event.data.sessionID;
  const form = event.data.form;
  if (isRecord(form) && typeof form.sessionID === "string")
    return form.sessionID;
  return undefined;
}

function parentOf(event: Record<string, unknown>): string | undefined {
  if (!isRecord(event.data)) return undefined;
  return typeof event.data.parentID === "string"
    ? event.data.parentID
    : undefined;
}

function durableSeq(event: Record<string, unknown>): number | undefined {
  if (!isRecord(event.durable)) return undefined;
  return typeof event.durable.seq === "number" ? event.durable.seq : undefined;
}

function nextDurableSeq(events: readonly Record<string, unknown>[]): number {
  let max = -1;
  for (const event of events) {
    const seq = durableSeq(event);
    if (seq !== undefined && seq > max) max = seq;
  }
  return max + 1;
}

function requiredSeq(event: Record<string, unknown>): number {
  const seq = durableSeq(event);
  if (seq === undefined) throw new Error("durable seq was removed before play");
  return seq;
}

function requiredSession(event: Record<string, unknown>): string {
  const sessionID = sessionOf(event);
  if (sessionID === undefined) throw new Error("session id");
  return sessionID;
}

function toNative(event: Record<string, unknown>): OpenCodeNativeEvent {
  if (typeof event.type !== "string") throw new Error("native event");
  const data = isRecord(event.data) ? event.data : undefined;
  const durableRecord = isRecord(event.durable) ? event.durable : undefined;
  const id = typeof event.id === "string" ? event.id : undefined;
  const created = typeof event.created === "number" ? event.created : undefined;
  const aggregateID =
    durableRecord !== undefined && typeof durableRecord.aggregateID === "string"
      ? durableRecord.aggregateID
      : undefined;
  const seq =
    durableRecord !== undefined && typeof durableRecord.seq === "number"
      ? durableRecord.seq
      : undefined;
  const version =
    durableRecord !== undefined && typeof durableRecord.version === "number"
      ? durableRecord.version
      : undefined;
  const durable =
    durableRecord === undefined
      ? undefined
      : {
          ...(aggregateID !== undefined ? { aggregateID } : {}),
          ...(seq !== undefined ? { seq } : {}),
          ...(version !== undefined ? { version } : {}),
        };
  return {
    type: event.type,
    ...(id !== undefined ? { id } : {}),
    ...(created !== undefined ? { created } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(durable !== undefined ? { durable } : {}),
  };
}

function countType(events: readonly { type: string }[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

function nativeBoundaries(events: readonly Record<string, unknown>[]): {
  started: number;
  completed: number;
} {
  let started = 0;
  let completed = 0;
  for (const event of events) {
    if (event.type === "session.execution.started") started += 1;
    if (
      typeof event.type === "string" &&
      TERMINAL_NATIVE_TYPES.has(event.type)
    ) {
      completed += 1;
    }
  }
  return { started, completed };
}

function projectRecorded(
  threadId: string,
  ownedSessionID: string,
  cwd: string,
  segments: readonly (readonly Record<string, unknown>[])[],
) {
  const translator = createOpenCodeDeltaTranslator();
  const collector = createBridgeDeltaEventCollector("opencode");
  const recordedEvents: ReturnType<typeof collector.assembleMessage> = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    if (index > 0) {
      translator.reset(ownedSessionID);
      recordedEvents.push(
        ...collector.assembleMessage({
          method: "thread/delta",
          params: { threadId, deltas: [{ kind: "session.reset" }] },
        }),
      );
    }
    for (const event of segment) {
      const eventSessionID = sessionOf(event) ?? ownedSessionID;
      const parentID = parentOf(event);
      const translated = translator.translate(toNative(event), {
        threadId,
        ownedSessionID,
        eventSessionID,
        cwd,
        modelContextWindow: null,
        persistApprovals: false,
        ...(parentID !== undefined ? { parentID } : {}),
      });
      const reconciled = translated.gap
        ? translator.reconcileAfterResync(eventSessionID, [])
        : [];
      if (reconciled.length > 0) {
        recordedEvents.push(
          ...collector.assembleMessage({
            method: "thread/delta",
            params: { threadId, deltas: reconciled },
          }),
        );
      }
      if (translated.deltas.length > 0) {
        recordedEvents.push(
          ...collector.assembleMessage({
            method: "thread/delta",
            params: { threadId, deltas: translated.deltas },
          }),
        );
      }
    }
  }
  return recordedEvents;
}

async function playAll(
  harness: OpenCodeBridgeHarness,
  events: readonly Record<string, unknown>[],
): Promise<void> {
  for (const event of events) {
    await harness.fake.play(event);
    await harness.rpc.flushWork();
  }
}

function assembled(harness: OpenCodeBridgeHarness) {
  const collector = createBridgeDeltaEventCollector("opencode");
  return harness.rpc.messages.flatMap((message) =>
    collector.assembleMessage(message),
  );
}

async function observeStalls(
  harness: OpenCodeBridgeHarness,
  ready: () => boolean,
  label: string,
): Promise<string[]> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (ready()) return [];
    await harness.rpc.flushWork();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  return [`timed out waiting for ${label}`];
}

async function checkCell(
  harness: OpenCodeBridgeHarness,
  cell: Cell,
  threadId: string,
  ownedSessionID: string,
  segments: readonly (readonly Record<string, unknown>[])[],
): Promise<ReturnType<typeof assembled>> {
  const flat = segments.flat();
  const bounds = nativeBoundaries(flat);
  const recordedEvents = projectRecorded(
    threadId,
    ownedSessionID,
    harness.workspaceDir,
    segments,
  );
  expect(bounds.started).toBeGreaterThan(0);
  expect(bounds.completed).toBe(bounds.started);
  expect(countType(recordedEvents, "turn/started")).toBe(bounds.started);
  expect(countType(recordedEvents, "turn/completed")).toBe(bounds.completed);
  const stalls = await observeStalls(
    harness,
    () => {
      const live = assembled(harness);
      return (
        countType(live, "turn/started") === bounds.started &&
        countType(live, "turn/completed") === bounds.completed &&
        live.length > 0
      );
    },
    cell,
  );
  const events = assembled(harness);
  expect(events).not.toBe(recordedEvents);
  const results = checkRecordedCellReplay({
    provider: "opencode",
    cell,
    events,
    recordedEvents,
    stalls,
  });
  expect(
    results
      .filter((result) => result.status !== "pass")
      .map((result) => `${result.id}: ${result.detail}`),
  ).toEqual([]);
  return events;
}

function expectDurableOpen(
  harness: OpenCodeBridgeHarness,
  threadId: string,
  started: Record<string, unknown>,
): void {
  const seq = requiredSeq(started);
  const sessionID = requiredSession(started);
  expect(harness.deltasOf(threadId)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "turn.open",
        providerTurnId: `exec:${sessionID}:${seq}`,
      }),
    ]),
  );
}

async function withCell(
  cell: Cell,
  run: (
    harness: OpenCodeBridgeHarness,
    owned: Record<string, unknown>[],
    child: Record<string, unknown>[],
  ) => Promise<void>,
): Promise<void> {
  const harness = await startOpenCodeBridgeHarness({
    prefix: `bb-opencode-recorded-${cell}-`,
    scriptTurns: false,
  });
  try {
    await run(
      harness,
      loadFixture("events-owned.sanitized.json"),
      loadFixture("child-events.sanitized.json"),
    );
  } finally {
    await harness.teardown();
  }
}

it("pins the recorded cells fed by the sanitized fixtures", () => {
  expect([...CELLS]).toEqual([
    "turn-tools",
    "user-question",
    "steer",
    "stop-interrupt",
    "fork",
    "resume",
    "compaction",
  ]);
  expect(loadFixture("events-owned.sanitized.json").length).toBeGreaterThan(0);
  expect(loadFixture("child-events.sanitized.json").length).toBeGreaterThan(0);
});

it.each(CELLS)(
  "%s replays sanitized events through the fake runtime",
  async (cell) => {
    await withCell(cell, async (harness, owned, child) => {
      if (cell === "turn-tools") {
        const started = await harness.startThread("thr_tools");
        const sessionId = providerThreadId(started);
        const played = sliceBetween(
          owned,
          "session.execution.started",
          "session.execution.succeeded",
        ).map((event) => rewrite(event, new Map([["SES_1", sessionId]])));
        await playAll(harness, played);
        const events = await checkCell(harness, cell, "thr_tools", sessionId, [
          played,
        ]);
        expectDurableOpen(harness, "thr_tools", played[0] ?? {});
        expect(events.some((event) => event.type === "item/completed")).toBe(
          true,
        );
        return;
      }

      if (cell === "user-question") {
        const started = await harness.startThread("thr_question");
        const sessionId = providerThreadId(started);
        const played = sliceBetween(
          owned,
          "session.execution.started",
          "form.created",
        ).map((event) => rewrite(event, new Map([["SES_1", sessionId]])));
        await playAll(harness, played);
        await checkCell(harness, cell, "thr_question", sessionId, [played]);
        expectDurableOpen(harness, "thr_question", played[0] ?? {});
        expect(
          harness.rpc.messages.some((message) => {
            if (
              message.method !== "interaction/request" ||
              !isRecord(message.params)
            )
              return false;
            const payload = message.params.payload;
            return isRecord(payload) && payload.kind === "user_question";
          }),
        ).toBe(true);
        return;
      }

      if (cell === "steer") {
        const started = await harness.startThread("thr_steer");
        const sessionId = providerThreadId(started);
        const turn = sliceBetween(
          owned,
          "session.execution.started",
          "session.execution.succeeded",
        ).map((event) => rewrite(event, new Map([["SES_1", sessionId]])));
        const [opened, ...rest] = turn;
        if (opened === undefined) throw new Error("steer fixture");
        await playAll(harness, [opened]);
        await harness.waitFor(
          () =>
            harness
              .deltasOf("thr_steer")
              .some((delta) => delta.kind === "turn.open"),
          "steer turn",
        );
        const open = harness
          .deltasOf("thr_steer")
          .find((delta) => delta.kind === "turn.open");
        if (open === undefined || typeof open.providerTurnId !== "string") {
          throw new Error("steer turn id");
        }
        const steered = await harness.request("creq_23456789ab", "turn/steer", {
          threadId: "thr_steer",
          providerThreadId: sessionId,
          clientRequestId: "creq_23456789ab",
          expectedTurnId: open.providerTurnId,
          input: [{ type: "text", text: "continue", mentions: [] }],
          options: EXECUTION_OPTIONS,
        });
        expect(steered.error).toBeUndefined();
        await playAll(harness, rest);
        await checkCell(harness, cell, "thr_steer", sessionId, [turn]);
        expectDurableOpen(harness, "thr_steer", opened);
        expect(harness.fake.calls.prompts[0]?.delivery).toBe("steer");
        return;
      }

      if (cell === "stop-interrupt") {
        const started = await harness.startThread("thr_stop");
        const sessionId = providerThreadId(started);
        const opening = sliceBetween(
          owned,
          "session.execution.started",
          "session.text.started",
        ).map((event) => rewrite(event, new Map([["SES_1", sessionId]])));
        expect(opening.map((event) => event.type)).toEqual(
          expect.arrayContaining([
            "session.execution.started",
            "session.tool.called",
            "session.text.started",
          ]),
        );
        await playAll(harness, opening);
        await harness.waitFor(
          () =>
            harness
              .deltasOf("thr_stop")
              .some((delta) => delta.kind === "turn.open"),
          "stop turn",
        );
        const stopped = await harness.request(81, "thread/stop", {
          threadId: "thr_stop",
          providerThreadId: sessionId,
          intent: "interrupt",
          activeTurnId: null,
        });
        expect(stopped.error).toBeUndefined();
        const transcript = [
          ...opening,
          {
            type: "session.execution.interrupted",
            data: { sessionID: sessionId },
          },
        ];
        const events = await checkCell(harness, cell, "thr_stop", sessionId, [
          transcript,
        ]);
        expectDurableOpen(harness, "thr_stop", opening[0] ?? {});
        expect(events.some((event) => event.type === "item/started")).toBe(
          true,
        );
        expect(harness.fake.calls.interrupts).toBe(1);
        return;
      }

      if (cell === "fork") {
        const started = await harness.startThread("thr_fork_source");
        const sourceId = providerThreadId(started);
        const forked = await harness.request(91, "thread/fork", {
          threadId: "thr_fork_child",
          cwd: harness.workspaceDir,
          sourceProviderThreadId: sourceId,
          instructionMode: "append",
          options: EXECUTION_OPTIONS,
        });
        expect(forked.error).toBeUndefined();
        const childId = providerThreadId(forked);
        const released = await harness.request(92, "thread/stop", {
          threadId: "thr_fork_child",
          providerThreadId: childId,
          intent: "release",
          activeTurnId: null,
        });
        expect(released.error).toBeUndefined();
        const parentTurn = sliceBetween(
          owned,
          "session.execution.started",
          "session.execution.succeeded",
        ).map((event) => rewrite(event, new Map([["SES_1", sourceId]])));
        const [parentStart, ...parentRest] = parentTurn;
        if (parentStart === undefined) throw new Error("fork fixture");
        const childBody = child.map((event) =>
          rewrite(
            event,
            new Map([
              ["SES_2", childId],
              ["SES_1", sourceId],
            ]),
          ),
        );
        const created = childBody.find(
          (event) => event.type === "session.created",
        );
        if (created === undefined) throw new Error("fork child");
        expect(parentOf(created)).toBe(sourceId);
        const childDone: Record<string, unknown> = {
          type: "session.execution.succeeded",
          data: { sessionID: childId, parentID: sourceId },
          durable: {
            aggregateID: childId,
            seq: nextDurableSeq(childBody),
            version: 1,
          },
        };
        const transcript = [
          parentStart,
          ...childBody,
          childDone,
          ...parentRest,
        ];
        await playAll(harness, transcript);
        await checkCell(harness, cell, "thr_fork_source", sourceId, [
          transcript,
        ]);
        expectDurableOpen(harness, "thr_fork_source", parentStart);
        expect(
          harness.deltasOf("thr_fork_source").some((delta) => {
            if (delta.kind !== "item.open" || !isRecord(delta.item))
              return false;
            return delta.item.type === "delegation";
          }),
        ).toBe(true);
        return;
      }

      if (cell === "resume") {
        const started = await harness.startThread("thr_resume");
        const sessionId = providerThreadId(started);
        const replacements = new Map([["SES_1", sessionId]]);
        const first = sliceBetween(
          owned,
          "session.execution.started",
          "session.execution.succeeded",
        ).map((event) => rewrite(event, replacements));
        const second = sliceBetween(
          owned,
          "session.execution.started",
          "session.compaction.ended",
          1,
        ).map((event) => rewrite(event, replacements));
        await playAll(harness, first);
        const released = await harness.request(101, "thread/stop", {
          threadId: "thr_resume",
          providerThreadId: sessionId,
          intent: "release",
          activeTurnId: null,
        });
        expect(released.error).toBeUndefined();
        const resumed = await harness.request(102, "thread/resume", {
          threadId: "thr_resume",
          cwd: harness.workspaceDir,
          providerThreadId: sessionId,
          instructionMode: "append",
          options: EXECUTION_OPTIONS,
        });
        expect(resumed.error).toBeUndefined();
        expect(providerThreadId(resumed)).toBe(sessionId);
        await playAll(harness, second);
        await checkCell(harness, cell, "thr_resume", sessionId, [
          first,
          second,
        ]);
        expectDurableOpen(harness, "thr_resume", first[0] ?? {});
        expectDurableOpen(harness, "thr_resume", second[0] ?? {});
        return;
      }

      const started = await harness.startThread("thr_compact");
      const sessionId = providerThreadId(started);
      const played = sliceBetween(
        owned,
        "session.execution.started",
        "session.compaction.ended",
        1,
      ).map((event) => rewrite(event, new Map([["SES_1", sessionId]])));
      await playAll(harness, played);
      await checkCell(harness, cell, "thr_compact", sessionId, [played]);
      expectDurableOpen(harness, "thr_compact", played[0] ?? {});
      expect(
        harness
          .deltasOf("thr_compact")
          .some((delta) => delta.kind === "context.compacted"),
      ).toBe(true);
    });
  },
  30_000,
);
