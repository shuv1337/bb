import { OpenCodeUnknownCheckpointError } from "./errors.js";

export function openCodeBeforeForInclusiveCheckpoint(
  context: readonly { id: string }[],
  checkpointMessageId: string,
): string | undefined {
  const index = context.findIndex(
    (message) => message.id === checkpointMessageId,
  );
  if (index === -1) {
    throw new OpenCodeUnknownCheckpointError(checkpointMessageId);
  }
  return context[index + 1]?.id;
}
