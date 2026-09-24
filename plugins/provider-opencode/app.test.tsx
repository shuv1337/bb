// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { companionProbeFrom, type CompanionStatus } from "./src/companion-status-contract.js";

const app = await loadPluginApp(() => import("./app"));

afterEach(cleanup);

function status(required: boolean): CompanionStatus {
  return {
    ...companionProbeFrom({
      engine: { appId: "opencode", version: "2.0.15", explicitServerUrl: true },
      hello: { kind: "absent", message: "bb.tools.v1 is not installed" },
      plugins: {
        kind: "ok",
        specs: [
          {
            id: "npm",
            source: "package",
            spec: "opencode-bb-tools",
            state: "active",
            error: null,
          },
          {
            id: "git",
            source: "package",
            spec: "github:shuv1337/opencode-bb-tools#v0.1.0",
            state: "active",
            error: null,
          },
        ],
      },
    }),
    machineId: "host-1",
    bbToolsRequired: required,
  };
}

describe("bb tools companion settings", () => {
  it("links the companion and shows the install command for the detected engine", async () => {
    const slot = renderSlot(app.settingsSections[0]!, {}, {
      sdk: {
        hosts: {
          list: async () => [
            { id: "host-1", name: "Studio", status: "connected" },
            { id: "host-2", name: "Laptop", status: "disconnected" },
          ],
        },
      },
      rpc: {
        companionStatus: () => status(true),
      },
    } as never);
    const link = await slot.findByRole("link", { name: "opencode-bb-tools" });
    expect(link.getAttribute("href")).toBe("https://github.com/shuv1337/opencode-bb-tools");
    expect(await slot.findByText("Studio")).toBeTruthy();
    expect(slot.getByText("opencode plugin add opencode-bb-tools")).toBeTruthy();
    expect(slot.getByText("Laptop offline")).toBeTruthy();
    expect(slot.getByText("Turns fail until the companion is installed.")).toBeTruthy();
    expect(slot.getByText("github:shuv1337/opencode-bb-tools#v0.1.0")).toBeTruthy();
  });
});
