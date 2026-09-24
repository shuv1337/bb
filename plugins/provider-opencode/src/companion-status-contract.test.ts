import { describe, expect, it } from "vitest";
import { bbToolsRequiredFromSettings, bbToolsRequiredSetupMessage, withBbToolsRequired } from "./bb-tools-required.js";
import { absentCompanionWarningDetails, ABSENT_COMPANION_WARNING_SUMMARY } from "./strings.js";
import { parseOpenCodeProviderOptions } from "./session-params.js";
import {
  companionPluginSpecsFrom,
  companionProbeFrom,
  companionProbeSchema,
  engineAppIdFrom,
  formatCompanionStatus,
  protocolRangesOverlap,
  type CompanionStatus,
  type EngineFacts,
} from "./companion-status-contract.js";

const engine: EngineFacts = {
  appId: "shuvcode",
  version: "2.0.15-shuv.2",
  explicitServerUrl: false,
};

const milestoneHello = {
  protocol: "bb.tools.v1",
  versions: { min: 1, max: 1 },
  package: { name: "opencode-bb-tools", version: "0.1.0" },
  install: { path: "/opt/opencode-bb-tools", digest: "abc123" },
  generation: "gen-1",
  instances: 1,
  features: { richFailures: false },
  limits: {
    maxOutstandingCalls: 8,
    maxResultBytes: 1024,
    maxToolsPerBinding: 32,
    ownerLeaseMs: 30000,
    maxPendingWaitMs: 1000,
  },
};

describe("companion status contract", () => {
  it("keeps milestone-1 hello fields and reports overlap with 1-1", () => {
    const probe = companionProbeSchema.parse(
      companionProbeFrom({
        engine,
        hello: { kind: "ok", value: milestoneHello },
        plugins: { kind: "ok", specs: [] },
      }),
    );
    expect(probe.detected).toBe(true);
    expect(probe.package).toEqual({ name: "opencode-bb-tools", version: "0.1.0" });
    expect(probe.protocol.versions).toEqual({ min: 1, max: 1 });
    expect(probe.protocol.overlapsSupported).toBe(true);
    expect(probe.install).toEqual({ path: "/opt/opencode-bb-tools", digest: "abc123" });
    expect(probe.instances).toBe(1);
    expect(probe.richFailures).toBe(false);
    expect(probe.limits?.maxOutstandingCalls).toBe(8);
    expect(probe.engine.installCommand).toBe("shuvcode plugin add opencode-bb-tools");
    expect(probe.repositoryUrl).toBe("https://github.com/shuv1337/opencode-bb-tools");
  });

  it("reports 0b hello versions, package, install, and instances as unknown", () => {
    const probe = companionProbeFrom({
      engine,
      hello: {
        kind: "ok",
        value: {
          protocol: "bb.tools.v1",
          version: 1,
          generation: "gen-0b",
          features: { richFailures: false },
        },
      },
      plugins: { kind: "ok", specs: [] },
    });
    expect(probe.detected).toBe(true);
    expect(probe.package).toEqual({ name: null, version: null });
    expect(probe.protocol.versions).toBeNull();
    expect(probe.protocol.legacyVersion).toBe(1);
    expect(probe.protocol.overlapsSupported).toBe(true);
    expect(probe.install).toEqual({ path: null, digest: null });
    expect(probe.instances).toBeNull();
    expect(probe.limits).toBeNull();
  });

  it("treats a legacy version outside 1 as unsupported without dropping the companion", () => {
    const probe = companionProbeFrom({
      engine,
      hello: {
        kind: "ok",
        value: { protocol: "bb.tools.v1", version: 99, generation: "gen" },
      },
      plugins: { kind: "ok", specs: [] },
    });
    expect(probe.detected).toBe(true);
    expect(probe.protocol.overlapsSupported).toBe(false);
    expect(protocolRangesOverlap({ min: 2, max: 2 }, { min: 1, max: 1 })).toBe(false);
    expect(protocolRangesOverlap({ min: 1, max: 2 }, { min: 1, max: 1 })).toBe(true);
  });

  it("lists installed specs when hello reports more than one instance", () => {
    const plugins = companionPluginSpecsFrom({
      data: [
        {
          id: "bb.tools",
          source: { type: "package", target: "opencode-bb-tools" },
          features: {},
          state: { status: "active" },
        },
        {
          id: "bb.tools.git",
          source: { type: "package", target: "github:shuv1337/opencode-bb-tools#v0.1.0" },
          features: {},
          state: { status: "active" },
        },
        {
          id: "other",
          source: { type: "package", target: "unrelated" },
          features: {},
          state: { status: "active" },
        },
      ],
    });
    const probe = companionProbeFrom({
      engine,
      hello: { kind: "ok", value: { ...milestoneHello, instances: 2 } },
      plugins,
    });
    expect(probe.duplicates).toBe(true);
    expect(probe.pluginSpecs.map((spec) => spec.spec)).toEqual([
      "opencode-bb-tools",
      "github:shuv1337/opencode-bb-tools#v0.1.0",
    ]);
  });

  it("names the companion, links it, and gives the install command in the absent warning", () => {
    const details = absentCompanionWarningDetails({
      toolNames: ["bb_lookup"],
      appId: "opencode",
    });
    expect(ABSENT_COMPANION_WARNING_SUMMARY).toBe("OpenCode does not run bb plugin tools");
    expect(details).toContain("Dropped dynamicTools: bb_lookup");
    expect(details).toContain("opencode-bb-tools");
    expect(details).toContain("https://github.com/shuv1337/opencode-bb-tools");
    expect(details).toContain("`opencode plugin add opencode-bb-tools`");
    expect(details).not.toContain("shuvcode plugin add");
  });
});

describe("engine install command", () => {
  it("does not treat the URL-mode registration placeholder as the engine", () => {
    expect(
      engineAppIdFrom({
        explicitServerUrl: true,
        healthAppId: null,
        pathBinaryAppId: null,
        version: "2.0.15",
        requestedApp: null,
      }),
    ).toBeNull();
    expect(
      engineAppIdFrom({
        explicitServerUrl: true,
        healthAppId: null,
        pathBinaryAppId: "opencode",
        version: "2.0.15-shuv.2",
        requestedApp: null,
      }),
    ).toBe("shuvcode");
    expect(
      engineAppIdFrom({
        explicitServerUrl: true,
        healthAppId: null,
        pathBinaryAppId: null,
        version: "2.0.15",
        requestedApp: "opencode",
      }),
    ).toBe("opencode");
  });
});

describe("bb tools required", () => {
  it("defaults off and only accepts an explicit true", () => {
    expect(bbToolsRequiredFromSettings({})).toBe(false);
    expect(bbToolsRequiredFromSettings({ bbToolsRequired: "true" })).toBe(false);
    expect(bbToolsRequiredFromSettings({ bbToolsRequired: true })).toBe(true);
    expect(
      withBbToolsRequired({ agent: null, variant: null }, { bbToolsRequired: true }),
    ).toEqual({ agent: null, variant: null, bbToolsRequired: true });
    expect(parseOpenCodeProviderOptions(undefined).bbToolsRequired).toBe(false);
    expect(parseOpenCodeProviderOptions({ bbToolsRequired: true }).bbToolsRequired).toBe(true);
    expect(bbToolsRequiredSetupMessage("shuvcode")).toContain(
      "`shuvcode plugin add opencode-bb-tools`",
    );
    expect(bbToolsRequiredSetupMessage(null)).toContain("or");
  });
});

describe("formatCompanionStatus", () => {
  it("prints the install command and repository for an absent companion", () => {
    const status: CompanionStatus = {
      ...companionProbeFrom({
        engine,
        hello: { kind: "absent", message: "bb.tools.v1 is not installed" },
        plugins: { kind: "ok", specs: [] },
      }),
      machineId: "host-1",
      bbToolsRequired: true,
    };
    const text = formatCompanionStatus(status);
    expect(text).toContain("Companion: not installed");
    expect(text).toContain("shuvcode plugin add opencode-bb-tools");
    expect(text).toContain("https://github.com/shuv1337/opencode-bb-tools");
    expect(text).toContain("Turns fail until the companion is installed.");
  });
});
