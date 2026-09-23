import { z } from "zod";

export const OPENCODE_PLUGIN_ID = "provider-opencode";
export const OPENCODE_AGENT_EXTENSION_KIND = `${OPENCODE_PLUGIN_ID}/agent` as const;
export const OPENCODE_MODEL_EXTENSION_KIND = `${OPENCODE_PLUGIN_ID}/model` as const;

export const opencodeAgentStateSchema = z.object({ agent: z.string().min(1) }).strict();
export const opencodeModelStateSchema = z.object({ model: z.string().min(1) }).strict();

export const opencodeExtensionKinds = {
  agent: { state: opencodeAgentStateSchema },
  model: { state: opencodeModelStateSchema },
} as const;
