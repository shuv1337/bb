import { afterEach, expect } from "vitest";

const UNHANDLED_KEY = Symbol.for("bb-plugin-provider-opencode.unhandled-rejections");

function unhandledRejections(): unknown[] {
  const existing: unknown = Reflect.get(globalThis, UNHANDLED_KEY);
  if (Array.isArray(existing)) return existing;
  const created: unknown[] = [];
  Reflect.set(globalThis, UNHANDLED_KEY, created);
  process.on("unhandledRejection", (reason) => {
    created.push(reason);
  });
  return created;
}

const unhandled = unhandledRejections();

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
