export class OpenCodeRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenCodeRuntimeError";
    this.code = code;
  }
}

export class OpenCodeRuntimeNotReadyError extends OpenCodeRuntimeError {
  constructor(message: string) {
    super("not_ready", message);
    this.name = "OpenCodeRuntimeNotReadyError";
  }
}

export class OpenCodeUnknownCheckpointError extends OpenCodeRuntimeError {
  constructor(checkpointMessageId: string) {
    super(
      "unknown_checkpoint",
      `Unknown checkpoint message ${checkpointMessageId}`,
    );
    this.name = "OpenCodeUnknownCheckpointError";
  }
}

export class OpenCodeUnknownAgentError extends OpenCodeRuntimeError {
  constructor(agent: string) {
    super("unknown_agent", `Unknown OpenCode agent "${agent}"`);
    this.name = "OpenCodeUnknownAgentError";
  }
}

export class OpenCodeInstructionReplaceError extends OpenCodeRuntimeError {
  constructor() {
    super(
      "instruction_replace_unsupported",
      "instructionMode replace is not supported on OpenCode sessions",
    );
    this.name = "OpenCodeInstructionReplaceError";
  }
}

export class OpenCodeUnauthenticatedError extends OpenCodeRuntimeError {
  constructor(
    message = "OpenCode rejected authentication",
    options?: ErrorOptions,
  ) {
    super("unauthenticated", message, options);
    this.name = "OpenCodeUnauthenticatedError";
  }
}

export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/Authorization:\s*\S+/gi, "Authorization: <redacted>")
    .replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic <redacted>")
    .replace(/password["']?\s*[:=]\s*["']?[^"'\s,]+/gi, "password=<redacted>");
}
