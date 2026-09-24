import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  interactionRequestPayloadSchema,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  createOpenCodeDeltaTranslator,
  IGNORED_EVENT_TYPES,
  nativeTerminalsFromEvents,
  UNOBSERVED_TOOL_OUTCOME,
  type OpenCodeTranslateContext,
} from "./delta-translation.js";
import { opencodeProviderDeclaration } from "./declaration.js";
import { openCodeFormPage, openCodeFormPageAnswer } from "./forms.js";
import type { OpenCodeNativeEvent } from "./runtime/index.js";

const UNRECORDED = [
  "session.compaction.failed",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.delta",
  "session.idle",
  "form.cancelled",
  "session.forked",
] as const;

const SETTLE_UNTIL_IDLE = [
  "session.execution.failed",
  "session.execution.interrupted",
] as const;

const CTX: OpenCodeTranslateContext = {
  threadId: "m0",
  ownedSessionID: "SES_1",
  eventSessionID: "SES_1",
  cwd: "/tmp/shuvcode/m0-workspace",
  modelContextWindow: null,
  persistApprovals: false,
};

function readJson(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(label);
  }
  return value;
}

function recordedEvents(value: unknown): OpenCodeNativeEvent[] {
  if (!Array.isArray(value)) {
    throw new Error("events-owned");
  }
  return value.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof (entry as { type?: unknown }).type !== "string"
    ) {
      throw new Error("events-owned event");
    }
    return entry as OpenCodeNativeEvent;
  });
}

describe("delta translation pinned to M0 recordings", () => {
  it("maps or ignores every recorded event name", () => {
    const types = readJson("event-types.json");
    if (types === null || typeof types !== "object") {
      throw new Error("event-types");
    }
    const record = types as { owned?: unknown; allSeen?: unknown };
    const recorded = new Set([
      ...stringList(record.owned, "owned"),
      ...stringList(record.allSeen, "allSeen"),
    ]);
    const owned = recordedEvents(readJson("events-owned.sanitized.json"));
    const sampleOverrides: Record<string, OpenCodeNativeEvent> = {
      "session.created": {
        type: "session.created",
        data: { sessionID: "SES_CHILD", parentID: "SES_1", title: "helper" },
      },
      "session.tool.failed": recordedEvents(readJson("tool-failed.sanitized.json"))[0] ?? {
        type: "session.tool.failed",
        data: { sessionID: "SES_1", id: "call_1" },
      },
      "session.usage.updated": {
        type: "session.usage.updated",
        data: {
          sessionID: "SES_1",
          tokens: { input: 3, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    };
    const sampleOf = (type: string): OpenCodeNativeEvent =>
      sampleOverrides[type] ??
      owned.find((event) => event.type === type) ?? {
        type,
        data: { sessionID: "SES_1", id: "evt_1" },
      };
    const outcomes = [...recorded, ...SETTLE_UNTIL_IDLE].map((type) => {
      const translator = createOpenCodeDeltaTranslator();
      if (type !== "session.execution.started") {
        translator.translate(
          { type: "session.execution.started", data: { sessionID: "SES_1" } },
          CTX,
        );
      }
      const sample = sampleOf(type);
      const sessionID = sample.data?.sessionID;
      const result = translator.translate(sample, {
        ...CTX,
        eventSessionID: typeof sessionID === "string" ? sessionID : CTX.eventSessionID,
      });
      const unhandled = result.deltas.some((delta) => delta.kind === "unhandled");
      if (IGNORED_EVENT_TYPES.has(type)) {
        return {
          type,
          outcome:
            result.deltas.length === 0 && result.interactions.length === 0
              ? "ignored"
              : "ignored-with-output",
        };
      }
      if (unhandled) return { type, outcome: "unhandled" };
      if (result.deltas.length === 0 && result.interactions.length === 0) {
        return { type, outcome: "silent" };
      }
      return { type, outcome: "mapped" };
    });
    expect(
      outcomes.filter(
        (entry) => entry.outcome !== "mapped" && entry.outcome !== "ignored",
      ),
    ).toEqual([]);
    expect(
      [...IGNORED_EVENT_TYPES].filter((type) => !recorded.has(type)),
    ).toEqual([]);
    expect(
      outcomes
        .filter((entry) => entry.outcome === "mapped")
        .map((entry) => entry.type),
    ).toEqual(
      expect.arrayContaining([
        "session.execution.started",
        "session.execution.succeeded",
        "session.text.delta",
        "session.tool.called",
        "session.tool.failed",
        "permission.asked",
        "form.created",
        ...SETTLE_UNTIL_IDLE,
      ]),
    );
    for (const type of [...UNRECORDED, "vendor.never.recorded"]) {
      expect(recorded.has(type)).toBe(false);
      expect(IGNORED_EVENT_TYPES.has(type)).toBe(false);
      const result = createOpenCodeDeltaTranslator().translate(
        { type, data: { sessionID: "SES_1" } },
        CTX,
      );
      expect(result.deltas.map((delta) => delta.kind)).toEqual(["unhandled"]);
    }
  });

  it("leaves unrecorded names unhandled", () => {
    const translator = createOpenCodeDeltaTranslator();
    for (const type of UNRECORDED) {
      const result = translator.translate(
        {
          type,
          data: {
            sessionID: "SES_1",
            id: "call_1",
            assistantMessageID: "MSG_1",
            ordinal: 0,
            delta: "think",
            text: "think",
            name: "read",
            message: "working",
            content: "out",
            error: { message: "nope" },
            metadata: { message: "working" },
            state: { thoughtSignature: "secret-sig" },
          },
        },
        CTX,
      );
      expect(result.interactions).toEqual([]);
      expect(result.deltas.map((delta) => delta.kind)).toEqual(["unhandled"]);
      expect(result.deltas[0]).toMatchObject({ rawType: type });
      const encoded = JSON.stringify(result.deltas);
      expect(encoded).not.toContain("thoughtSignature");
      expect(encoded).not.toContain("secret-sig");
    }
  });

  it("translates the owned capture without inventing event names", () => {
    const types = readJson("event-types.json");
    if (types === null || typeof types !== "object") {
      throw new Error("event-types");
    }
    const owned = stringList(
      (types as { owned?: unknown }).owned,
      "owned",
    );
    const events = recordedEvents(readJson("events-owned.sanitized.json"));
    const seen = new Set(events.map((event) => event.type));
    expect([...seen].sort()).toEqual([...owned].sort());
    const translator = createOpenCodeDeltaTranslator();
    const translated = events.map((event) => translator.translate(event, CTX));
    const deltas = translated.flatMap((result) => result.deltas);
    const interactions = translated.flatMap((result) => result.interactions);
    const unrecorded = new Set<string>(UNRECORDED);
    expect(JSON.stringify(deltas)).not.toContain("thoughtSignature");
    expect(
      deltas.some(
        (delta) => delta.kind === "unhandled" && unrecorded.has(delta.rawType),
      ),
    ).toBe(false);
    expect(deltas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "item.textDelta",
          channel: "agentMessage",
          text: "m0",
        }),
        expect.objectContaining({ kind: "context.compacted" }),
      ]),
    );
    expect(
      deltas.some(
        (delta) =>
          delta.kind === "item.close" &&
          delta.status === "completed" &&
          delta.item.type === "fileRead",
      ),
    ).toBe(true);
    expect(
      deltas.some(
        (delta) =>
          (delta.kind === "item.textDelta" || delta.kind === "item.textClose") &&
          delta.channel === "reasoningText",
      ),
    ).toBe(false);
    expect(interactions.map((interaction) => interaction.payload.kind)).toEqual(
      expect.arrayContaining(["approval", "user_question"]),
    );
  });

  it("translates every owned event without an unhandled delta", () => {
    const events = recordedEvents(readJson("events-owned.sanitized.json"));
    const translator = createOpenCodeDeltaTranslator();
    const deltas = events.flatMap((event) => translator.translate(event, CTX).deltas);
    expect(deltas.filter((delta) => delta.kind === "unhandled")).toEqual([]);
  });
});

function translateAll(
  events: readonly OpenCodeNativeEvent[],
  ctx: OpenCodeTranslateContext = CTX,
  translator = createOpenCodeDeltaTranslator(),
): ThreadDelta[] {
  return events.flatMap((event) => {
    const sessionID = event.data?.sessionID;
    return translator.translate(event, {
      ...ctx,
      eventSessionID: typeof sessionID === "string" ? sessionID : ctx.eventSessionID,
    }).deltas;
  });
}

function turnDeltas(deltas: readonly ThreadDelta[]) {
  return deltas.flatMap((delta) =>
    delta.kind === "turn.boundary" ||
    (delta.kind === "turn.open" && delta.parentRef === undefined)
      ? [delta]
      : [],
  );
}

describe("delta translation turn lifecycle", () => {
  it("keeps a recorded compaction inside the open turn until execution ends", () => {
    const events = recordedEvents(readJson("events-owned.sanitized.json"));
    const start = events
      .map((event) => event.type)
      .lastIndexOf("session.execution.started");
    const compaction = events.slice(start);
    expect(compaction.map((event) => event.type)).toContain("session.compaction.ended");
    const translator = createOpenCodeDeltaTranslator();
    const during = translateAll(compaction, CTX, translator);
    expect(turnDeltas(during).map((delta) => delta.kind)).toEqual(["turn.open"]);
    expect(during.map((delta) => delta.kind)).toContain("context.compacted");
    const after = translateAll(
      [{ type: "session.execution.succeeded", data: { sessionID: "SES_1" } }],
      CTX,
      translator,
    );
    expect(turnDeltas(after)).toEqual([
      expect.objectContaining({ kind: "turn.boundary", status: "completed" }),
    ]);
  });

  it("keys a turn opened by a child session before execution starts", () => {
    const deltas = translateAll([
      {
        type: "session.created",
        data: { sessionID: "SES_CHILD", parentID: "SES_1", title: "helper" },
      },
      { type: "session.execution.started", data: { sessionID: "SES_1" } },
      { type: "session.execution.succeeded", data: { sessionID: "SES_1" } },
    ]);
    const turns = turnDeltas(deltas);
    expect(turns.map((delta) => delta.kind)).toEqual(["turn.open", "turn.boundary"]);
    const [open, boundary] = turns;
    expect(open?.providerTurnId).toEqual(expect.any(String));
    expect(boundary?.providerTurnId).toBe(open?.providerTurnId);
  });

  it("opens the turn for a tool result that was never opened", () => {
    const deltas = translateAll([
      {
        type: "session.tool.success",
        data: { sessionID: "SES_1", id: "call_1", content: "done" },
      },
    ]);
    expect(deltas.map((delta) => delta.kind)).toEqual([
      "turn.open",
      "item.open",
      "item.close",
    ]);
  });

  it("reports a shell command's exit code from its result trailer", () => {
    const deltas = translateAll([
      { type: "session.execution.started", data: { sessionID: "SES_1" } },
      {
        type: "session.tool.input.started",
        data: { sessionID: "SES_1", id: "call_1", name: "bash" },
      },
      {
        type: "session.tool.success",
        data: {
          sessionID: "SES_1",
          id: "call_1",
          content: [
            { type: "text", text: "No module named pytest\n\nCommand exited with code 1." },
          ],
        },
      },
    ]);
    const close = deltas.find((delta) => delta.kind === "item.close");
    expect(close).toMatchObject({ exitCode: 1, item: { exitCode: 1 } });
  });

  it("prefers a numeric exit code in the tool metadata", () => {
    const deltas = translateAll([
      { type: "session.execution.started", data: { sessionID: "SES_1" } },
      {
        type: "session.tool.input.started",
        data: { sessionID: "SES_1", id: "call_1", name: "bash" },
      },
      {
        type: "session.tool.success",
        data: { sessionID: "SES_1", id: "call_1", content: "boom", metadata: { exit: 2 } },
      },
    ]);
    const close = deltas.find((delta) => delta.kind === "item.close");
    expect(close).toMatchObject({ exitCode: 2 });
  });

  it("ignores live permission, progress, step-failure, and selection events", () => {
    const deltas = translateAll([
      { type: "session.execution.started", data: { sessionID: "SES_1" } },
      { type: "session.permissions", data: { sessionID: "SES_1", permissions: [] } },
      {
        type: "session.tool.progress",
        data: { sessionID: "SES_1", id: "call_1", metadata: { shellID: "sh_1" } },
      },
      { type: "session.step.failed", data: { sessionID: "SES_1" } },
      {
        type: "session.agent.selected",
        data: { sessionID: "SES_1", agent: "plan" },
      },
      {
        type: "session.model.selected",
        data: { sessionID: "SES_1", model: { id: "gpt", providerID: "openai" } },
      },
    ]);
    expect(deltas.some((delta) => delta.kind === "unhandled")).toBe(false);
  });

  it("closes open items and delegations before an interrupted boundary", () => {
    const deltas = translateAll([
      { type: "session.execution.started", data: { sessionID: "SES_1" } },
      {
        type: "session.tool.input.started",
        data: { sessionID: "SES_1", id: "call_1", name: "bash" },
      },
      {
        type: "session.text.started",
        data: { sessionID: "SES_1", assistantMessageID: "msg_1", ordinal: 0 },
      },
      {
        type: "session.created",
        data: { sessionID: "SES_CHILD", parentID: "SES_1", title: "helper" },
      },
      { type: "session.execution.interrupted", data: { sessionID: "SES_1" } },
    ]);
    const tail = deltas.slice(deltas.findIndex((delta) => delta.kind === "item.close"));
    expect(
      tail.map((delta) => [
        delta.kind,
        "status" in delta ? delta.status : undefined,
      ]),
    ).toEqual([
      ["item.close", "interrupted"],
      ["item.close", "interrupted"],
      ["item.textClose", undefined],
      ["turn.boundary", "interrupted"],
    ]);
  });

  it("forgets a detached session", () => {
    const translator = createOpenCodeDeltaTranslator();
    translateAll(
      [{ type: "session.execution.started", data: { sessionID: "SES_1" } }],
      CTX,
      translator,
    );
    expect(translator.executionTurnId("SES_1")).toEqual(expect.any(String));
    translator.forget("SES_1");
    expect(translator.executionTurnId("SES_1")).toBeUndefined();
  });
});

describe("bb tool rows", () => {
  const presentation = {
    label: { pending: "Echoing", completed: "Echoed" },
    icon: { glyph: "Workflow" },
    tint: { light: "#abc", dark: "#123" },
    suppress: true,
  };

  function bbTranslator() {
    const translator = createOpenCodeDeltaTranslator();
    translator.configureInjectedTools("SES_1", [{ name: "bb_echo", presentation }], "b1");
    return translator;
  }

  function toolRows(deltas: ThreadDelta[]) {
    return deltas.filter((delta) => delta.kind === "item.open" || delta.kind === "item.close");
  }

  it("stamps one bb row with the supplied presentation and maps a leaked internal name", () => {
    const translator = bbTranslator();
    const deltas = translateAll(
      [
        { type: "session.execution.started", data: { sessionID: "SES_1" } },
        {
          type: "session.tool.input.started",
          data: { sessionID: "SES_1", id: "call_1", name: "bbt_b1_0" },
        },
        {
          type: "session.tool.called",
          data: { sessionID: "SES_1", id: "call_1", input: { text: "hello" } },
        },
        {
          type: "session.tool.success",
          data: { sessionID: "SES_1", id: "call_1", content: [{ type: "text", text: "echo: hello" }] },
        },
      ],
      CTX,
      translator,
    );
    const rows = toolRows(deltas);
    expect(rows.map((delta) => delta.kind)).toEqual(["item.open", "item.close"]);
    expect(rows[0]).toMatchObject({
      item: { type: "tool", server: "bb", tool: "bb_echo" },
      presentation,
    });
    expect(rows[1]).toMatchObject({
      status: "completed",
      item: { type: "tool", server: "bb", tool: "bb_echo", args: { text: "hello" } },
      presentation,
    });
  });

  it("nests a child bb tool under the child session", () => {
    const translator = bbTranslator();
    translator.translate(
      { type: "session.created", data: { sessionID: "SES_CHILD", parentID: "SES_1", title: "helper" } },
      CTX,
    );
    const deltas = translateAll(
      [
        {
          type: "session.tool.input.started",
          data: { sessionID: "SES_CHILD", id: "call_child", name: "bb_echo" },
        },
      ],
      { ...CTX, eventSessionID: "SES_CHILD" },
      translator,
    );
    expect(deltas.find((delta) => delta.kind === "item.open")).toMatchObject({
      key: { providerItemId: "call_child", parentRef: "SES_CHILD" },
      item: { type: "tool", server: "bb", tool: "bb_echo" },
    });
  });

  it("closes a failed bb call as failed and an aborted call as interrupted", () => {
    const translator = bbTranslator();
    const failed = translateAll(
      [
        { type: "session.execution.started", data: { sessionID: "SES_1" } },
        {
          type: "session.tool.input.started",
          data: { sessionID: "SES_1", id: "call_fail", name: "bb_echo" },
        },
        {
          type: "session.tool.failed",
          data: {
            sessionID: "SES_1",
            id: "call_fail",
            error: { type: "tool.execution", message: "first failure block" },
            executed: false,
          },
        },
        {
          type: "session.tool.failed",
          data: {
            sessionID: "SES_1",
            id: "call_fail",
            error: { type: "tool.execution", message: "first failure block" },
          },
        },
      ],
      CTX,
      translator,
    );
    const failedRows = toolRows(failed);
    expect(failedRows).toHaveLength(2);
    expect(failedRows[1]).toMatchObject({
      status: "failed",
      resultText: "first failure block",
      item: { type: "tool", server: "bb", tool: "bb_echo", error: "first failure block" },
    });
    const interrupted = translateAll(
      [
        {
          type: "session.tool.input.started",
          data: { sessionID: "SES_1", id: "call_stop", name: "bb_echo" },
        },
        {
          type: "session.tool.failed",
          data: {
            sessionID: "SES_1",
            id: "call_stop",
            error: { type: "aborted", message: "Tool execution interrupted" },
            executed: false,
          },
        },
      ],
      CTX,
      translator,
    );
    expect(toolRows(interrupted).at(-1)).toMatchObject({
      status: "interrupted",
      resultText: "Tool execution interrupted",
    });
  });

  it("translates the captured failed and aborted tool events", () => {
    const translator = bbTranslator();
    const [failed, aborted] = recordedEvents(readJson("tool-failed.sanitized.json"));
    if (failed === undefined || aborted === undefined) throw new Error("tool-failed fixture");
    const failedClose = translateAll(
      [
        { type: "session.tool.input.started", data: { sessionID: "SES_1", id: "call_1", name: "bb_echo" } },
        failed,
      ],
      CTX,
      translator,
    ).find((delta) => delta.kind === "item.close");
    const abortedClose = translateAll(
      [
        { type: "session.tool.input.started", data: { sessionID: "SES_1", id: "call_2", name: "bb_echo" } },
        aborted,
      ],
      CTX,
      translator,
    ).find((delta) => delta.kind === "item.close");
    expect(failedClose).toMatchObject({ status: "failed", resultText: "first failure block" });
    expect(abortedClose).toMatchObject({ status: "interrupted", resultText: "Tool execution interrupted" });
    expect(JSON.stringify([failedClose, abortedClose])).not.toContain("/tmp/");
    expect(JSON.stringify([failedClose, abortedClose])).not.toContain("ses_");
  });

  it("does not mark an open tool succeeded on resync without a native terminal", () => {
    const translator = bbTranslator();
    translateAll(
      [
        { type: "session.execution.started", data: { sessionID: "SES_1" } },
        {
          type: "session.tool.input.started",
          data: { sessionID: "SES_1", id: "call_open", name: "bb_echo" },
        },
      ],
      CTX,
      translator,
    );
    const reconciled = translator.reconcileAfterResync("SES_1", [
      { id: "msg_1", type: "assistant", content: [{ type: "tool", state: { input: { token: "secret" } } }] },
    ]);
    expect(reconciled.some((delta) => delta.kind === "item.close")).toBe(false);
    expect(reconciled.some((delta) => delta.kind === "turn.boundary")).toBe(false);
    expect(JSON.stringify(reconciled)).not.toContain("secret");
    expect(translator.executionTurnId("SES_1")).toEqual(expect.any(String));
  });

  it("reconciles a dropped failure from the native log without copying its arguments", () => {
    const translator = bbTranslator();
    translateAll(
      [
        { type: "session.execution.started", data: { sessionID: "SES_1" } },
        {
          type: "session.tool.input.started",
          data: { sessionID: "SES_1", id: "call_drop", name: "bb_echo" },
        },
        {
          type: "session.tool.called",
          data: { sessionID: "SES_1", id: "call_drop", input: { text: "known" } },
        },
      ],
      CTX,
      translator,
    );
    translator.noteNativeTerminals(
      "SES_1",
      nativeTerminalsFromEvents(
        [
          { type: "session.execution.started", durable: { seq: 0 }, data: { sessionID: "SES_1" } },
          {
            type: "session.tool.failed",
            data: {
              id: "call_drop",
              input: { token: "secret-arg" },
              error: { type: "tool.execution", message: "bb tool failed" },
            },
          },
          { type: "session.execution.failed", data: { sessionID: "SES_1" } },
        ],
        true,
      ),
    );
    const reconciled = translator.reconcileAfterResync("SES_1", [{ id: "msg_9", type: "assistant" }]);
    const close = reconciled.find((delta) => delta.kind === "item.close" && delta.key.providerItemId === "call_drop");
    expect(close).toMatchObject({
      status: "failed",
      resultText: "bb tool failed",
      item: { type: "tool", server: "bb", tool: "bb_echo", args: { text: "known" }, error: "bb tool failed" },
    });
    expect(JSON.stringify(reconciled)).not.toContain("secret-arg");
    expect(reconciled).toContainEqual(expect.objectContaining({ kind: "turn.boundary", status: "failed" }));
  });

  it("keeps a new compaction open when an earlier execution already compacted", () => {
    const translator = bbTranslator();
    translateAll(
      [
        { type: "session.execution.started", data: { sessionID: "SES_1" }, durable: { seq: 1 } },
        { type: "session.compaction.started", data: { sessionID: "SES_1" } },
        { type: "session.compaction.ended", data: { sessionID: "SES_1" } },
        { type: "session.execution.succeeded", data: { sessionID: "SES_1" } },
        { type: "session.execution.started", data: { sessionID: "SES_1" }, durable: { seq: 8 } },
        { type: "session.compaction.started", data: { sessionID: "SES_1" } },
      ],
      CTX,
      translator,
    );
    translator.noteNativeTerminals(
      "SES_1",
      nativeTerminalsFromEvents(
        [
          { type: "session.execution.started", durable: { seq: 1 } },
          { type: "session.compaction.ended" },
          { type: "session.execution.succeeded" },
          { type: "session.execution.started", durable: { seq: 8 } },
        ],
        true,
      ),
    );
    const reconciled = translator.reconcileAfterResync("SES_1", []);
    expect(reconciled.some((delta) => delta.kind === "item.close")).toBe(false);
    expect(reconciled.some((delta) => delta.kind === "turn.boundary")).toBe(false);
  });

  it("does not close a new turn with the previous execution's success", () => {
    const translator = bbTranslator();
    translateAll(
      [
        { type: "session.execution.started", data: { sessionID: "SES_1" }, durable: { seq: 1 } },
        { type: "session.execution.succeeded", data: { sessionID: "SES_1" } },
        { type: "session.execution.started", data: { sessionID: "SES_1" }, durable: { seq: 5 } },
        {
          type: "session.tool.input.started",
          data: { sessionID: "SES_1", id: "call_new", name: "bb_echo" },
        },
      ],
      CTX,
      translator,
    );
    translator.noteNativeTerminals(
      "SES_1",
      nativeTerminalsFromEvents(
        [
          { type: "session.execution.started", durable: { seq: 1 } },
          { type: "session.execution.succeeded" },
        ],
        true,
      ),
    );
    expect(translator.reconcileAfterResync("SES_1", []).some((delta) => delta.kind === "turn.boundary")).toBe(
      false,
    );
    translator.noteNativeTerminals(
      "SES_1",
      nativeTerminalsFromEvents(
        [
          { type: "session.execution.started", durable: { seq: 1 } },
          { type: "session.execution.succeeded" },
          { type: "session.execution.started", durable: { seq: 5 } },
        ],
        true,
      ),
    );
    const reconciled = translator.reconcileAfterResync("SES_1", []);
    expect(reconciled.some((delta) => delta.kind === "turn.boundary")).toBe(false);
    expect(reconciled.some((delta) => delta.kind === "item.close")).toBe(false);
    expect(translator.executionTurnId("SES_1")).toBe("exec:SES_1:5");
  });

  it("keeps one row when a settled call's start and terminal are replayed", () => {
    const translator = bbTranslator();
    const first = translateAll(
      [
        { type: "session.execution.started", data: { sessionID: "SES_1" } },
        {
          type: "session.tool.input.started",
          data: { sessionID: "SES_1", id: "call_once", name: "bb_echo" },
        },
        {
          type: "session.tool.failed",
          data: {
            sessionID: "SES_1",
            id: "call_once",
            error: { type: "tool.execution", message: "once" },
          },
        },
      ],
      CTX,
      translator,
    );
    const replay = translateAll(
      [
        {
          type: "session.tool.input.started",
          data: { sessionID: "SES_1", id: "call_once", name: "bb_echo" },
        },
        {
          type: "session.tool.failed",
          data: {
            sessionID: "SES_1",
            id: "call_once",
            error: { type: "tool.execution", message: "again" },
          },
        },
      ],
      CTX,
      translator,
    );
    const rows = [...first, ...replay].filter(
      (delta) => delta.kind === "item.open" || delta.kind === "item.close",
    );
    expect(rows.map((delta) => delta.kind)).toEqual(["item.open", "item.close"]);
  });

  it("closes an idle session from activity when the log has no terminal, and leaves an active one open", () => {
    const translator = bbTranslator();
    translateAll(
      [
        { type: "session.execution.started", data: { sessionID: "SES_1" }, durable: { seq: 2 } },
        {
          type: "session.tool.input.started",
          data: { sessionID: "SES_1", id: "call_gap", name: "bb_echo" },
        },
      ],
      CTX,
      translator,
    );
    translator.noteNativeTerminals("SES_1", nativeTerminalsFromEvents([], false));
    translator.noteSessionLiveness("SES_1", { outcome: undefined, idleAt: undefined, active: true });
    expect(translator.reconcileAfterResync("SES_1", []).some((delta) => delta.kind === "turn.boundary")).toBe(
      false,
    );
    translator.noteNativeTerminals(
      "SES_1",
      nativeTerminalsFromEvents(
        [{ type: "session.execution.started", durable: { seq: 2 } }, { type: "session.step.streamed" }],
        false,
      ),
    );
    expect(translator.reconcileAfterResync("SES_1", []).some((delta) => delta.kind === "item.close")).toBe(
      false,
    );
    translator.noteSessionLiveness("SES_1", {
      outcome: "succeeded",
      idleAt: 10,
      active: false,
    });
    const closed = translator.reconcileAfterResync("SES_1", []);
    expect(closed.find((delta) => delta.kind === "item.close")).toMatchObject({
      status: "failed",
      resultText: UNOBSERVED_TOOL_OUTCOME,
    });
    expect(closed).toContainEqual(expect.objectContaining({ kind: "turn.boundary", status: "completed" }));
  });
});

describe("delta translation usage", () => {
  it("excludes reasoning from total tokens", () => {
    const deltas = translateAll([
      {
        type: "session.usage.updated",
        data: {
          sessionID: "SES_1",
          tokens: { input: 10, output: 5, reasoning: 7, cache: { read: 2, write: 1 } },
        },
      },
    ]);
    const usage = deltas.find((delta) => delta.kind === "usage");
    expect(usage).toMatchObject({
      total: { totalTokens: 18, reasoningOutputTokens: 7 },
    });
  });
});

describe("delta translation extension kinds", () => {
  it("emits only declared agent and model states", async () => {
    const declared = opencodeProviderDeclaration().extensionKinds ?? {};
    const deltas = translateAll([
      {
        type: "session.step.started",
        data: {
          sessionID: "SES_1",
          agent: "build",
          model: { providerID: "google", id: "gemini" },
        },
      },
    ]);
    const states = deltas.flatMap((delta) =>
      delta.kind === "extension.state" ? [delta] : [],
    );
    expect(states.map((state) => state.extensionKind)).toEqual([
      "provider-opencode/agent",
      "provider-opencode/model",
    ]);
    for (const state of states) {
      const schema = declared[state.extensionKind.replace("provider-opencode/", "")]?.state;
      if (schema === undefined) throw new Error(`undeclared ${state.extensionKind}`);
      const result = await schema["~standard"].validate(state.payload);
      expect(result.issues).toBeUndefined();
    }
  });
});

function interactionsOf(
  event: OpenCodeNativeEvent,
  ctx: OpenCodeTranslateContext = CTX,
) {
  return createOpenCodeDeltaTranslator().translate(event, ctx).interactions;
}

describe("delta translation approvals", () => {
  const read: OpenCodeNativeEvent = {
    type: "permission.asked",
    data: { id: "per_1", sessionID: "SES_1", action: "read", resources: ["hello.txt"] },
  };

  it("omits allow_for_session unless approvals persist", () => {
    const [ephemeral] = interactionsOf(read);
    const [persistent] = interactionsOf(read, { ...CTX, persistApprovals: true });
    expect(ephemeral?.payload).toMatchObject({ availableDecisions: ["allow_once", "deny"] });
    expect(persistent?.payload).toMatchObject({
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    });
  });

  it("presents a read approval as a tool use", () => {
    const [interaction] = interactionsOf(read);
    expect(interaction?.payload).toMatchObject({
      kind: "approval",
      subject: { kind: "tool_use", tool: "read" },
    });
  });
});

describe("delta translation forms", () => {
  const fields = [
    { key: "name", type: "string", required: true },
    { key: "count", type: "integer", required: true },
    { key: "confirm", type: "boolean" },
    {
      key: "tags",
      type: "multiselect",
      options: ["a", "b", "c", "d", "e"].map((value) => ({ value, label: value })),
    },
    { key: "email", type: "string", format: "email" },
    { key: "secret", type: "string", hidden: true },
  ];

  it("turns a form that exceeds one question into answerable pages", () => {
    const [interaction] = interactionsOf({
      type: "form.created",
      data: { form: { id: "FORM_2", sessionID: "SES_1", title: "Setup", fields } },
    });
    if (interaction?.kind !== "form") throw new Error("expected a form interaction");
    expect(interactionRequestPayloadSchema.safeParse(interaction.payload).success).toBe(true);
    expect(interaction.fields.map((field) => field.key)).toEqual([
      "name",
      "count",
      "confirm",
      "tags",
      "email",
    ]);
    const first = openCodeFormPage(interaction.fields, 0);
    const second = openCodeFormPage(interaction.fields, first.length);
    expect(second.map((field) => field.key)).toEqual(["email"]);
    expect(
      openCodeFormPageAnswer(first, {
        name: { selected: [], freeText: "bb" },
        count: { selected: [], freeText: "3" },
        confirm: { selected: ["true"] },
        tags: { selected: [], freeText: "a, e" },
      }),
    ).toEqual({ name: "bb", count: 3, confirm: true, tags: ["a", "e"] });
    expect(() =>
      openCodeFormPageAnswer(first, {
        name: { selected: [], freeText: "bb" },
        count: { selected: [], freeText: "3.5" },
      }),
    ).toThrow(/integer/);
  });
});
