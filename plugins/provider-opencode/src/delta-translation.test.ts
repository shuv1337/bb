import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createOpenCodeDeltaTranslator,
  type OpenCodeTranslateContext,
} from "./delta-translation.js";
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
};

function readJson(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../recordings/${name}`, import.meta.url), "utf8"),
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
});
