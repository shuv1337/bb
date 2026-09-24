import { afterEach, beforeEach, expect, it } from "vitest";
import {
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  type OpenCodeBridgeHarness,
  startOpenCodeBridgeHarness,
} from "./test-support.js";

const CONFORMANCE_WAIT_TIMEOUT_MS = 30_000;

let harness: OpenCodeBridgeHarness;

beforeEach(async () => {
  harness = await startOpenCodeBridgeHarness({
    prefix: "bb-opencode-conformance-",
    initialize: false,
    scriptTurns: true,
  });
});

afterEach(async () => {
  await harness.teardown();
});

it("passes the canonical protocol suite against a scripted OpenCode runtime", async () => {
  const report = await runBridgeConformance({
    transport: { send: harness.handleLine, takeMessages: harness.takeMessages },
    providerId: "opencode",
    session: {
      cwd: harness.workspaceDir,
      promptInput: [{ type: "text", text: "say hello", mentions: [] }],
      interruptiblePromptInput: [{ type: "text", text: "/hold", mentions: [] }],
    },
    timeoutMs: CONFORMANCE_WAIT_TIMEOUT_MS,
  });

  console.info(`opencode bridge conformance:\n${formatConformanceReport(report)}`);

  const statusById = Object.fromEntries(
    report.results.map((result) => [result.id, result.status]),
  );
  expect(statusById).toMatchObject({
    "rpc/unknown-method": "pass",
    "rpc/invalid-params": "pass",
    "rpc/non-json-ignored": "pass",
    "rpc/response-not-request": "pass",
    "handshake/initialize": "pass",
    "session/start-identity": "pass",
    "session/start-identity-announced": "pass",
    "turn/lifecycle": "pass",
    "events/schema-valid": "pass",
    "item/opens-before-delta": "pass",
    "stop/release-not-interrupted": "pass",
    "session/resume-identity": "pass",
    "session/resume-id-uniqueness": "pass",
    "session/fork-identity": "pass",
    "session/fork-identity-announced": "pass",
    "session/threads-independent": "pass",
    "stop/interrupt-settles-before-result": "pass",
  });
  expect(
    report.results.filter((result) => result.status !== "pass").map((result) => result.id),
  ).toEqual([]);
}, 60_000);

it("turn-tools recordings include a bb tool row with its presentation and failure", async () => {
  const started = await harness.startThread("thr_bb_tools", {
    dynamicTools: [
      {
        name: "bb_echo",
        description: "Echo text back through bb.",
        inputSchema: { type: "object" },
        presentation: {
          label: { pending: "Echoing", completed: "Echoed" },
          icon: { glyph: "Workflow" },
          suppress: true,
        },
      },
    ],
  });
  const result = started.result;
  if (result === null || typeof result !== "object" || !("providerThreadId" in result)) {
    throw new Error("missing providerThreadId");
  }
  const sessionId = String(result.providerThreadId);
  const events = [
    { type: "session.execution.started", data: { sessionID: sessionId }, durable: { seq: 1 } },
    {
      type: "session.tool.input.started",
      data: { sessionID: sessionId, id: "call_bb", name: "bb_echo" },
      durable: { seq: 2 },
    },
    {
      type: "session.tool.called",
      data: { sessionID: sessionId, id: "call_bb", input: { text: "hi" }, executed: true },
      durable: { seq: 3 },
    },
    {
      type: "session.tool.failed",
      data: {
        sessionID: sessionId,
        id: "call_bb",
        error: { type: "tool.execution", message: "bb tool failed" },
        executed: false,
      },
      durable: { seq: 4, version: 2 },
    },
  ];
  for (const event of events) {
    await harness.fake.play(event);
    await harness.rpc.flushWork();
  }
  const rows = harness.deltasOf("thr_bb_tools").filter((delta) => {
    const item = delta.item;
    return (
      (delta.kind === "item.open" || delta.kind === "item.close") &&
      item !== null &&
      typeof item === "object" &&
      "tool" in item &&
      item.tool === "bb_echo"
    );
  });
  expect(rows.map((delta) => delta.kind)).toEqual(["item.open", "item.close"]);
  expect(rows[0]).toMatchObject({
    item: { type: "tool", server: "bb", tool: "bb_echo" },
    presentation: {
      label: { pending: "Echoing", completed: "Echoed" },
      icon: { glyph: "Workflow" },
      suppress: true,
    },
  });
  expect(rows[1]).toMatchObject({
    status: "failed",
    resultText: "bb tool failed",
    item: { server: "bb", tool: "bb_echo", error: "bb tool failed" },
  });
});
