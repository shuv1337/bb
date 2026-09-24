import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachInputSchema,
  BB_TOOLS_CLIENT,
  BB_TOOLS_PROTOCOL_RANGE,
  checkBbToolsFixture,
  helloInputSchema,
  helloWireInput,
  pendingInputSchema,
  resultInputSchema,
  type BbToolsFixture,
} from "./tool-bridge-contract.js";

const root = join(import.meta.dirname, "fixtures/bb-tools-v1");

function fixtures(): Array<{ file: string; fixture: BbToolsFixture }> {
  return readdirSync(root)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      fixture: JSON.parse(readFileSync(join(root, file), "utf8")) as BbToolsFixture,
    }));
}

describe("bb.tools.v1 contract", () => {
  it("pins the companion package version and commit", () => {
    const pinned = readFileSync(join(root, "COMPANION_VERSION"), "utf8");
    expect(pinned).toContain("package=opencode-bb-tools");
    expect(pinned).toContain("version=0.1.0");
    expect(pinned).toContain("commit=d9770b5e201c0dcc2f570a6614702e204b38a328");
    expect(pinned).toContain("short=d9770b5");
  });

  it("validates every vendored fixture against bb schemas", () => {
    const loaded = fixtures();
    expect(loaded.length).toBeGreaterThanOrEqual(30);
    const methods = new Set<string>();
    for (const { file, fixture } of loaded) {
      methods.add(fixture.method);
      expect(checkBbToolsFixture(fixture), file).toBeUndefined();
    }
    for (const method of [
      "hello",
      "attach",
      "pending",
      "claim",
      "result",
      "status",
      "detach",
      "reject",
      "configure",
      "control",
    ]) {
      expect(methods.has(method), method).toBe(true);
    }
  });

  it("accepts the requests bb sends", () => {
    expect(helloInputSchema.parse(helloWireInput())).toEqual({
      client: BB_TOOLS_CLIENT,
      protocol: BB_TOOLS_PROTOCOL_RANGE,
    });
    expect(
      attachInputSchema.parse({
        sessionID: "ses_1",
        tools: [
          {
            name: "bb_echo",
            description: "Echo text.",
            inputSchema: { type: "object" },
          },
        ],
        disallowedTools: ["bb_hidden"],
        takeover: { capability: "cap_old" },
      }).sessionID,
    ).toBe("ses_1");
    expect(
      pendingInputSchema.parse({
        capability: "cap",
        acknowledged: ["k1"],
        waitMs: 0,
      }).waitMs,
    ).toBe(0);
    expect(
      resultInputSchema.parse({
        capability: "cap",
        key: "k1",
        success: false,
        contentItems: [{ type: "inputText", text: "nope" }],
      }).success,
    ).toBe(false);
  });
});
