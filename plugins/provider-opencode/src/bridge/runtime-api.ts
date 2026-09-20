import type { InstructionMode } from "@get-bb/plugin-sdk/provider-bridge";

export const OPENCODE_PLUGIN_ID = "provider-opencode";
export const OPENCODE_FORM_KIND = `${OPENCODE_PLUGIN_ID}/form` as const;
export const OPENCODE_AGENT_KIND = `${OPENCODE_PLUGIN_ID}/agent` as const;
export const OPENCODE_MODEL_KIND = `${OPENCODE_PLUGIN_ID}/model` as const;
export const BB_INSTRUCTIONS_KEY = "bb.instructions";

export interface OpenCodeModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export interface OpenCodeModel {
  id: string;
  providerID: string;
  name?: string;
  displayName?: string;
  description?: string;
  variants?: readonly { id: string }[];
  limit?: { context?: number };
}

export interface OpenCodeAgent {
  id?: string;
  name: string;
  mode?: string;
  hidden?: boolean;
}

export interface OpenCodeSkill {
  id: string;
  name: string;
  description?: string;
  path?: string;
}

export interface OpenCodeCommand {
  name: string;
  description?: string;
}

export interface OpenCodePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "ask" | "deny";
}

export type OpenCodePermissionRuleset = readonly OpenCodePermissionRule[];

export interface OpenCodeFileAttachment {
  mime: string;
  url: string;
  filename?: string;
}

export interface OpenCodePromptInput {
  text: string;
  files?: readonly OpenCodeFileAttachment[];
  skills?: readonly { id: string; mention?: { start: number; end: number; text: string } }[];
  delivery?: "steer" | "queue";
  id?: string;
}

export interface OpenCodeMessage {
  id: string;
  sessionID?: string;
  role?: string;
  type?: string;
}

export interface OpenCodeEvent {
  type: string;
  data?: unknown;
  durable?: {
    aggregateID?: string;
    seq?: number;
    version?: number;
  };
}

export interface CreateSessionInput {
  directory: string;
  title?: string;
  agent?: string;
  model?: OpenCodeModelRef;
  metadata: { bbThreadId: string };
  permissions?: OpenCodePermissionRuleset;
}

export interface SessionHandle {
  readonly id: string;
  readonly directory: string;
  readonly metadata: { readonly bbThreadId?: string };
  prompt(input: OpenCodePromptInput): Promise<{ id: string }>;
  command(input: { name: string; text: string; files?: readonly OpenCodeFileAttachment[]; delivery?: "steer" | "queue" }): Promise<void>;
  compact(): Promise<void>;
  interrupt(): Promise<void>;
  switchAgent(agent: string): Promise<void>;
  switchModel(model: OpenCodeModelRef): Promise<void>;
  update(patch: { title?: string; permissions?: OpenCodePermissionRuleset }): Promise<void>;
  fork(before?: string): Promise<SessionHandle>;
  replyPermission(requestID: string, reply: "once" | "always" | "reject"): Promise<void>;
  replyForm(formID: string, answer: Record<string, string | number | boolean | string[]>): Promise<void>;
  setEnvironment(env: Record<string, string>): Promise<void>;
  putInstructionEntry(key: string, value: string): Promise<void>;
  context(): Promise<readonly OpenCodeMessage[]>;
}

export interface OpenCodeRuntime {
  info(): Promise<{ version: string; url?: string }>;
  models(location: { directory: string }): Promise<OpenCodeModel[]>;
  defaultModel(location: { directory: string }): Promise<OpenCodeModel | null>;
  agents(location: { directory: string }): Promise<OpenCodeAgent[]>;
  skills(location: { directory: string }): Promise<OpenCodeSkill[]>;
  commands(location: { directory: string }): Promise<OpenCodeCommand[]>;
  createSession(input: CreateSessionInput): Promise<SessionHandle>;
  openSession(sessionID: string): Promise<SessionHandle>;
  subscribe(sessionID: string, signal: AbortSignal): AsyncIterable<OpenCodeEvent>;
  close(): Promise<void>;
}

export type CreateOpenCodeRuntime = () => Promise<OpenCodeRuntime>;

export interface InstructionModeError {
  mode: InstructionMode;
}
