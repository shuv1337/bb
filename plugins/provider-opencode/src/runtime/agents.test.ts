import { describe, expect, it } from "vitest";
import { extractConfigDefaultAgent, resolveDefaultAgentId } from "./agents.js";
import type { OpenCodeAgent } from "./types.js";

const agents: OpenCodeAgent[] = [
  { id: "build", name: "Build", mode: "primary", hidden: false },
  { id: "plan", name: "Plan", mode: "primary", hidden: false },
  { id: "explore", name: "Explore", mode: "subagent", hidden: false },
  { id: "hidden", name: "H", mode: "primary", hidden: true },
];

describe("default agent", () => {
  it("uses the last config document default_agent when selectable", () => {
    expect(
      extractConfigDefaultAgent([
        { type: "document", info: { default_agent: "plan" } },
        { type: "directory" },
        { type: "document", info: { default_agent: "build" } },
      ]),
    ).toBe("build");
    expect(
      resolveDefaultAgentId({
        agents,
        configDefaultAgent: "plan",
      }),
    ).toBe("plan");
  });

  it("ignores subagent and hidden config defaults and falls back to build", () => {
    expect(
      resolveDefaultAgentId({
        agents,
        configDefaultAgent: "explore",
      }),
    ).toBe("build");
  });

});
