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
