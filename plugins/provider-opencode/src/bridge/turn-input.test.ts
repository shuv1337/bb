import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { expect, it } from "vitest";
import { extractOpenCodeTurnInput } from "./turn-input.js";

function commandMention(
  name: string,
  start: number,
  source: "command" | "skill",
) {
  return {
    start,
    end: start + name.length + 1,
    resource: {
      kind: "command" as const,
      trigger: "/" as const,
      name,
      source,
      origin: "user" as const,
      label: name,
      argumentHint: null,
    },
  };
}

it("sends a nested slash command to session.command with OpenCode's slash name", () => {
  const text = "/team:review src/auth.ts";
  const extracted = extractOpenCodeTurnInput([
    {
      type: "text",
      text,
      mentions: [commandMention("team:review", 0, "command")],
    },
  ]);
  expect(extracted.command).toEqual({
    name: "team/review",
    text: "src/auth.ts",
  });
  expect(extracted.skills).toEqual([]);
});

it("attaches a skill mention by catalog id and leaves command text alone", () => {
  const input: PromptInput[] = [
    {
      type: "text",
      text: "/nested/team",
      mentions: [commandMention("nested/team", 0, "skill")],
    },
  ];
  expect(extractOpenCodeTurnInput(input)).toMatchObject({
    skills: [{ id: "nested/team" }],
    command: null,
  });
});
