import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server.js";
import { companionProbeFrom, type CompanionProbe } from "./companion-status-contract.js";

function probe(): CompanionProbe {
  return companionProbeFrom({
    engine: { appId: "shuvcode", version: "2.0.15-shuv.2", explicitServerUrl: false },
    hello: { kind: "absent", message: "bb.tools.v1 is not installed" },
    plugins: { kind: "ok", specs: [] },
  });
}

describe("bb opencode tools status", () => {
  it("returns the host probe through plugin RPC and the CLI", async () => {
    const host = createFakePluginHost({
      pluginId: "provider-opencode",
      experimental_callHostRpc: () => probe(),
    });
    host.harness.sdk.stub("hosts.list", async () => [
      { id: "host-1", name: "Studio", status: "connected" },
    ]);
    plugin(host.bb);
    const rpc = await host.harness.callRpc("companionStatus", { machineId: "host-1" });
    expect(rpc).toMatchObject({
      machineId: "host-1",
      detected: false,
      bbToolsRequired: false,
      repositoryUrl: "https://github.com/shuv1337/opencode-bb-tools",
    });
    const json = await host.harness.runCli([
      "tools",
      "status",
      "--machine",
      "host-1",
      "--json",
    ]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ machineId: "host-1", detected: false });
    const text = await host.harness.runCli(["tools", "status", "--machine", "host-1"]);
    expect(text.stdout).toContain("shuvcode plugin add opencode-bb-tools");
    const missing = await host.harness.runCli(["tools", "status", "--machine", "missing"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("No machine missing");
  });
});
