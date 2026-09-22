import { afterEach, expect } from "vitest";

const unhandled: unknown[] = [];

process.on("unhandledRejection", (reason) => {
  unhandled.push(reason);
});

afterEach(() => {
  const seen = unhandled.splice(0, unhandled.length);
  if (seen.length === 0) return;
  const details = seen
    .map((reason) =>
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    )
    .join("\n");
  expect.fail(`unhandled rejection\n${details}`);
});
