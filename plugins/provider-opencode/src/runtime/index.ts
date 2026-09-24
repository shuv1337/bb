export type {
  CreateOpenCodeRuntimeOptions,
  CreateSessionInput,
  OpenCodeAgent,
  OpenCodeAgentCatalog,
  OpenCodeCommand,
  OpenCodeCommandInput,
  DurableLogRead,
  OpenCodeDiscoveryHealth,
  OpenCodeHealthStatus,
  OpenCodeInstructionMode,
  OpenCodeJsonValue,
  OpenCodeLocation,
  OpenCodeModel,
  OpenCodeModelLimit,
  OpenCodeModelRef,
  OpenCodeModelVariant,
  OpenCodeNativeEvent,
  OpenCodePermissionMode,
  OpenCodePermissionRule,
  OpenCodePromptFile,
  OpenCodePromptInput,
  OpenCodePromptSkill,
  OpenCodeRuntime,
  OpenCodeSessionInfo,
  OpenCodeSessionMessage,
  OpenCodeTokenUsage,
  OpenCodeSkill,
  RuntimeNativeEvent,
  RuntimeResyncEvent,
  RuntimeSessionEvent,
  RuntimeStreamErrorEvent,
  SessionHandle,
} from "./types.js";
export {
  BB_INSTRUCTION_ENTRY_KEY,
  INFO_PROBE_TIMEOUT_MS,
  SSE_CONNECT_TIMEOUT_MS,
  SUBSCRIBER_BUFFER_LIMIT,
} from "./types.js";
export {
  OpenCodeInstructionReplaceError,
  OpenCodeRuntimeError,
  OpenCodeRuntimeNotReadyError,
  OpenCodeUnauthenticatedError,
  OpenCodeUnknownAgentError,
  OpenCodeUnknownCheckpointError,
  sanitizeErrorMessage,
} from "./errors.js";
export {
  assertSelectableAgentId,
  extractConfigDefaultAgent,
  isSelectableAgent,
  resolveDefaultAgentId,
  resolvePlanExitAgentId,
} from "./agents.js";
export { openCodeBeforeForInclusiveCheckpoint } from "./fork.js";
export {
  createFakeOpenCodeRuntime,
  type CreateFakeOpenCodeRuntimeOptions,
  type FakeOpenCodeRuntime,
} from "./fake-runtime.js";
export { createHttpOpenCodeRuntime } from "./http-runtime.js";
export {
  basicAuthHeader,
  parseAppIdFromVersion,
  probeInfo,
  scanLiveRegistrations,
  selectLiveRegistration,
  resolveAttachedRegistration,
} from "./discovery.js";

import { createHttpOpenCodeRuntime } from "./http-runtime.js";
import type {
  CreateOpenCodeRuntimeOptions,
  OpenCodeRuntime,
} from "./types.js";

export async function createOpenCodeRuntime(
  options: CreateOpenCodeRuntimeOptions = {},
): Promise<OpenCodeRuntime> {
  return createHttpOpenCodeRuntime(options);
}
