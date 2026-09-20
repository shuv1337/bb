import { describe, expect, it } from "vitest";
import { messageFrom, sanitizeUnknown, sessionInfoFrom } from "./context.js";

describe("context sanitization", () => {
  it("keeps usage and strips thoughtSignature", () => {
    const message = messageFrom({
      id: "msg_1",
      type: "assistant",
      finish: "stop",
      tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 0, write: 0 } },
      cost: 0,
      content: [
        {
          type: "tool",
          state: { thoughtSignature: "secret", input: { path: "a" } },
        },
      ],
    });
    expect(message?.finish).toBe("stop");
    expect(message?.tokens?.output).toBe(2);
    const content = message?.content as Array<{ state: Record<string, unknown> }>;
    expect(content[0]?.state.thoughtSignature).toBeUndefined();
    expect(content[0]?.state.input).toEqual({ path: "a" });
  });

  it("hydrates session status fields", () => {
    const info = sessionInfoFrom(
      {
        id: "ses_1",
        cost: 1.5,
        outcome: "succeeded",
        tokens: { input: 4, output: 5, reasoning: 0, cache: { read: 1, write: 2 } },
        location: { directory: "/tmp" },
      },
      { directory: "/" },
    );
    expect(info.outcome).toBe("succeeded");
    expect(info.tokens?.cache.write).toBe(2);
  });

  it("drops password keys", () => {
    expect(sanitizeUnknown({ password: "x", ok: 1 })).toEqual({ ok: 1 });
  });
});
