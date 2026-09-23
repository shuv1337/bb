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

  it("redacts keys ending in a credential word and keeps keys that only start with one", () => {
    expect(
      sanitizeUnknown({
        secretName: "prod-db",
        passwordHint: "the usual",
        authorizationUrl: "https://example.test/authorize",
        Authorization: "Basic abc",
        secret: "s",
        client_secret: "cs",
        clientSecret: "cs",
        db_password: "dbp",
        apiPassword: "ap",
        "proxy-authorization": "Basic def",
        proxyAuthorization: "Basic def",
        secret_key: "sk",
        api_key: "ak",
        APIKey: "ak",
        accessToken: "at",
        thought_signature: "ts",
        tokens: { input: 1, output: 2 },
        nested: [{ PASSWORD: "p", thoughtSignature: "t", keep: true }],
      }),
    ).toEqual({
      secretName: "prod-db",
      passwordHint: "the usual",
      authorizationUrl: "https://example.test/authorize",
      tokens: { input: 1, output: 2 },
      nested: [{ keep: true }],
    });
  });

  it("keeps tool arguments whose names contain a redacted word", () => {
    const message = messageFrom({
      id: "msg_2",
      type: "assistant",
      content: [
        {
          type: "tool",
          state: { input: { secretName: "api", password: "hunter2" } },
        },
      ],
    });
    expect(message?.content).toEqual([
      { type: "tool", state: { input: { secretName: "api" } } },
    ]);
  });
});
