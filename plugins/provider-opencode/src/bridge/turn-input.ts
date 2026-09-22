import path from "node:path";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import type { OpenCodePromptFile } from "../runtime/index.js";

export interface OpenCodeSkillMention {
  id: string;
}

export interface OpenCodeNativeCommand {
  name: string;
  text: string;
}

export interface ExtractedOpenCodeTurnInput {
  text: string;
  files: OpenCodePromptFile[];
  skills: OpenCodeSkillMention[];
  command: OpenCodeNativeCommand | null;
}

function fileUri(filePath: string): string {
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(filePath);
  return `file://${absolute}`;
}

export function extractOpenCodeTurnInput(
  input: readonly PromptInput[],
): ExtractedOpenCodeTurnInput {
  const chunks: string[] = [];
  const files: OpenCodePromptFile[] = [];
  const skills: OpenCodeSkillMention[] = [];
  let command: OpenCodeNativeCommand | null = null;
  for (const item of input) {
    if (item.type === "text") {
      chunks.push(item.text);
      for (const mention of item.mentions) {
        const resource = mention.resource;
        if (resource.kind !== "command") {
          continue;
        }
        const mentioned = item.text.slice(mention.start, mention.end);
        if (
          resource.source === "skill" &&
          (resource.trigger === "/" || resource.trigger === "$") &&
          mentioned === `${resource.trigger}${resource.name}`
        ) {
          skills.push({ id: resource.name });
          continue;
        }
        if (
          resource.source === "command" &&
          resource.origin !== "builtin" &&
          mentioned === `${resource.trigger}${resource.name}`
        ) {
          const remainder =
            `${item.text.slice(0, mention.start)}${item.text.slice(mention.end)}`.trim();
          command = {
            name: resource.name.split(":").join("/"),
            text: remainder,
          };
        }
      }
    } else if (item.type === "localImage" || item.type === "localFile") {
      files.push({
        uri: fileUri(item.path),
        name:
          item.type === "localFile"
            ? (item.name ?? path.basename(item.path))
            : path.basename(item.path),
      });
    } else if (item.type === "image") {
      files.push({ uri: item.url });
    }
  }
  return {
    text: chunks.join("\n"),
    files,
    skills,
    command,
  };
}
