export type OpenCodeLocation = {
  directory: string;
};

export type OpenCodeModelRef = {
  providerID: string;
  id: string;
  variant?: string;
};

export type OpenCodePermissionRule = {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
};

export type OpenCodePermissionMode = "accept-edits" | "auto" | "full";

export type OpenCodeInstructionMode = "append" | "replace";

export type OpenCodeHealthStatus =
  | "ready"
  | "not_installed"
  | "unauthenticated"
  | "expired"
  | "unsupported_version"
  | "unknown";

export type OpenCodeDiscoveryHealth = {
  status: OpenCodeHealthStatus;
  statusMessage: string | null;
  appId: string | null;
  version: string | null;
  installedVersion: string | null;
  url: string | null;
  registrationFile: string | null;
  pid: number | null;
  pathBinaryAppId: string | null;
};

export type OpenCodeModelVariant = {
  id: string;
  label: string;
};

export type OpenCodeModelLimit = {
  context: number;
  input?: number;
  output: number;
};

export type OpenCodeModel = {
  providerID: string;
  id: string;
  modelID: string;
  name: string;
  variants: readonly OpenCodeModelVariant[];
  enabled: boolean;
  isDefault: boolean;
  defaultVariant?: string;
  limit?: OpenCodeModelLimit;
};

export type OpenCodeAgent = {
  id: string;
  name: string;
  mode: "primary" | "subagent" | "all";
  hidden: boolean;
  description?: string;
};

export type OpenCodeAgentCatalog = {
  agents: readonly OpenCodeAgent[];
  defaultAgentId: string | null;
};

export type OpenCodeSkill = {
  id: string;
  name: string;
  description?: string;
  path: string;
};

export type OpenCodeCommand = {
  name: string;
  description?: string;
};

export type OpenCodeTokenUsage = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export type OpenCodeSessionInfo = {
  id: string;
  parentID?: string;
  title?: string;
  agent?: string;
  model?: OpenCodeModelRef;
  metadata?: Record<string, unknown>;
  location: OpenCodeLocation;
  tokens?: OpenCodeTokenUsage;
  cost?: number;
  outcome?: "succeeded" | "failed" | "interrupted";
};

export type OpenCodeSessionMessage = {
  id: string;
  type: string;
  text?: string;
  agent?: string;
  model?: OpenCodeModelRef;
  skill?: string;
  finish?: string;
  tokens?: OpenCodeTokenUsage;
  cost?: number;
  content?: unknown;
};

export type OpenCodePromptSkill = {
  id: string;
};

export type OpenCodePromptFile = {
  uri: string;
  name?: string;
};

export type OpenCodePromptInput = {
  text: string;
  skills?: readonly OpenCodePromptSkill[];
  files?: readonly OpenCodePromptFile[];
  delivery?: "steer" | "queue";
  id?: string;
};

export type OpenCodeJson =
  | null
  | boolean
  | number
  | string
  | OpenCodeJson[]
  | { readonly [key: string]: OpenCodeJson };

export type CreateSessionInput = {
  location: OpenCodeLocation;
  title?: string;
  agent?: string;
  model?: OpenCodeModelRef;
  metadata?: { readonly [key: string]: OpenCodeJson };
  permissionMode?: OpenCodePermissionMode;
  permissions?: readonly OpenCodePermissionRule[];
  instructions?: { mode: OpenCodeInstructionMode; text: string };
  environment?: Record<string, string>;
};

export type OpenCodeNativeEvent = {
  type: string;
  id?: string;
  created?: number;
  data?: Record<string, unknown>;
  durable?: {
    aggregateID?: string;
    seq?: number;
    version?: number;
  };
};

export type RuntimeNativeEvent = {
  kind: "native";
  sessionID: string;
  parentID?: string;
  event: OpenCodeNativeEvent;
};

export type RuntimeResyncEvent = {
  kind: "resync";
  sessionID: string;
  reason: "reconnect" | "overflow";
};

export type RuntimeStreamErrorEvent = {
  kind: "stream.error";
  sessionID: string;
  message: string;
};

export type RuntimeSessionEvent =
  | RuntimeNativeEvent
  | RuntimeResyncEvent
  | RuntimeStreamErrorEvent;

export type CreateOpenCodeRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  execVersion?: (
    binary: string,
  ) => Promise<{ stdout: string; status: number }>;
  which?: (command: string) => string | undefined;
  kill?: (pid: number, signal: 0) => boolean;
  readFile?: (path: string) => Promise<string>;
  readdir?: (path: string) => Promise<string[]>;
  regularFileMtimeMs?: (path: string) => Promise<number | null>;
  realpath?: (path: string) => Promise<string>;
  isDirectory?: (path: string) => Promise<boolean>;
  localAddresses?: () => string[];
};

export interface SessionHandle {
  readonly id: string;
  readonly location: OpenCodeLocation;
  info(): Promise<OpenCodeSessionInfo>;
  prompt(input: OpenCodePromptInput): Promise<void>;
  command(input: { name: string; text?: string }): Promise<void>;
  compact(): Promise<void>;
  interrupt(): Promise<void>;
  switchAgent(agent: string): Promise<void>;
  switchModel(model: OpenCodeModelRef): Promise<void>;
  update(patch: {
    title?: string;
    permissions?: OpenCodePermissionRule[];
  }): Promise<void>;
  fork(checkpointMessageId?: string): Promise<SessionHandle>;
  context(): Promise<readonly OpenCodeSessionMessage[]>;
  replyPermission(
    requestID: string,
    reply: "once" | "always" | "reject",
  ): Promise<void>;
  replyForm(
    formID: string,
    answer: Record<string, string | number | boolean | string[]>,
  ): Promise<void>;
  cancelForm(formID: string): Promise<void>;
  setEnvironment(variables: Record<string, string>): Promise<void>;
  setInstructions(input: {
    mode: OpenCodeInstructionMode;
    text: string;
  }): Promise<void>;
}

export interface OpenCodeRuntime {
  info(): Promise<{ version: string; url: string; appId: string | null }>;
  health(): Promise<OpenCodeDiscoveryHealth>;
  models(location: OpenCodeLocation): Promise<OpenCodeModel[]>;
  agents(location: OpenCodeLocation): Promise<OpenCodeAgentCatalog>;
  skills(location: OpenCodeLocation): Promise<OpenCodeSkill[]>;
  commands(location: OpenCodeLocation): Promise<OpenCodeCommand[]>;
  createSession(input: CreateSessionInput): Promise<SessionHandle>;
  openSession(sessionID: string): Promise<SessionHandle>;
  subscribe(
    sessionID: string,
    signal: AbortSignal,
  ): AsyncIterable<RuntimeSessionEvent>;
  close(): Promise<void>;
}

export const BB_INSTRUCTION_ENTRY_KEY = "bb.instructions";
export const SUBSCRIBER_BUFFER_LIMIT = 1_024;
export const INFO_PROBE_TIMEOUT_MS = 4_000;
export const REGISTRATION_PROBE_TIMEOUT_MS = 1_500;
export const EVENT_STREAM_BACKOFF_INITIAL_MS = 250;
export const EVENT_STREAM_BACKOFF_MAX_MS = 8_000;
export const EVENT_STREAM_STABLE_MS = 10_000;
export const VERSION_PROBE_TIMEOUT_MS = 3_000;
export const SSE_CONNECT_TIMEOUT_MS = 8_000;
