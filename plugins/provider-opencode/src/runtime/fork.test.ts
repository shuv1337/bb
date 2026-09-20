import { describe, expect, it } from "vitest";
import { OpenCodeUnknownCheckpointError } from "./errors.js";
import { openCodeBeforeForInclusiveCheckpoint } from "./fork.js";

describe("openCodeBeforeForInclusiveCheckpoint", () => {
  const context = [{ id: "msg_a" }, { id: "msg_b" }, { id: "msg_c" }];

  it("maps an inclusive checkpoint to the next message as exclusive before", () => {
    expect(openCodeBeforeForInclusiveCheckpoint(context, "msg_b")).toBe("msg_c");
  });

  it("omits before when the checkpoint is the last message", () => {
    expect(openCodeBeforeForInclusiveCheckpoint(context, "msg_c")).toBeUndefined();
  });

  it("fails unknown checkpoints", () => {
    expect(() => openCodeBeforeForInclusiveCheckpoint(context, "msg_z")).toThrow(
      OpenCodeUnknownCheckpointError,
    );
  });
});
