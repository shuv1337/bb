import { describe, expect, it } from "vitest";
import { sessionRulesForPermissionMode } from "./permissions.js";

function lastMatch(
  rules: ReturnType<typeof sessionRulesForPermissionMode>,
  action: string,
  resource: string,
): string | undefined {
  let effect: string | undefined;
  for (const rule of rules) {
    const actionOk = rule.action === "*" || rule.action === action;
    const resourceOk =
      rule.resource === "*" ||
      rule.resource === resource ||
      (rule.resource === "*.env" &&
        (resource === ".env" || resource.endsWith("/.env"))) ||
      (rule.resource === "*.env.*" &&
        (resource.startsWith(".env.") || resource.includes("/.env.")));
    if (actionOk && resourceOk) effect = rule.effect;
  }
  return effect;
}

describe("sessionRulesForPermissionMode", () => {
  it("overrides agent wildcard allow so unknown actions ask in non-full modes", () => {
    const rules = sessionRulesForPermissionMode("accept-edits");
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "ask" });
    expect(lastMatch(rules, "webfetch", "https://example.com")).toBe("ask");
    expect(lastMatch(rules, "subagent", "explore")).toBe("ask");
  });

  it("asks before editing env files even when edit is allowed", () => {
    const rules = sessionRulesForPermissionMode("accept-edits");
    expect(lastMatch(rules, "edit", "src/a.ts")).toBe("allow");
    expect(lastMatch(rules, "edit", ".env")).toBe("ask");
    expect(lastMatch(rules, "read", ".env")).toBe("ask");
    expect(lastMatch(rules, "external_directory", "/tmp")).toBe("ask");
    expect(rules.some((rule) => rule.resource === "*.env.example")).toBe(false);
  });

  it("allows shell and read for auto but still asks env and outside", () => {
    const rules = sessionRulesForPermissionMode("auto");
    expect(lastMatch(rules, "shell", "ls")).toBe("allow");
    expect(lastMatch(rules, "read", "src/a.ts")).toBe("allow");
    expect(lastMatch(rules, "edit", ".env.local")).toBe("ask");
    expect(lastMatch(rules, "read", ".env")).toBe("ask");
    expect(lastMatch(rules, "webfetch", "*")).toBe("ask");
  });

  it("uses a single wildcard allow for full", () => {
    expect(sessionRulesForPermissionMode("full")).toEqual([
      { action: "*", resource: "*", effect: "allow" },
    ]);
  });
});
