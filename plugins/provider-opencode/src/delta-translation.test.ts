import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  interactionRequestPayloadSchema,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  createOpenCodeDeltaTranslator,
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
  "session.tool.failed",
  "session.tool.progress",
  "session.tool.input.delta",
  "session.idle",
  "form.cancelled",
  "session.forked",
  "session.permissions",
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
  it("switches only on recorded names plus the contract settle trio", () => {
    const types = readJson("event-types.json");
    if (types === null || typeof types !== "object") {
      throw new Error("event-types");
    }
    const record = types as { owned?: unknown; allSeen?: unknown };
    const allowed = new Set([
      ...stringList(record.owned, "owned"),
      ...stringList(record.allSeen, "allSeen"),
      ...SETTLE_UNTIL_IDLE,
    ]);
    const source = readFileSync(
      new URL("./delta-translation.ts", import.meta.url),
      "utf8",
    );
    const cases = [...source.matchAll(/case "([^"]+)"/g)].map((match) => match[1]);
    const ignoredStart = source.indexOf("const IGNORED_EVENT_TYPES = new Set([");
    const ignoredEnd = source.indexOf("]);", ignoredStart);
    const ignored = [
      ...source.slice(ignoredStart, ignoredEnd).matchAll(/"([^"]+)"/g),
    ].map((match) => match[1]);
    expect(cases.filter((name) => !allowed.has(name))).toEqual([]);
    expect(ignored.filter((name) => !allowed.has(name))).toEqual([]);
    expect(cases.filter((name) => ignored.includes(name))).toEqual([]);
    for (const name of UNRECORDED) {
      expect(source).not.toContain(`"${name}"`);
    }
    expect(cases).toEqual(
      expect.arrayContaining([
        "session.execution.succeeded",
        ...SETTLE_UNTIL_IDLE,
      ]),
    );
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
