import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import opencodePlugin from "./server.js";
import { deriveOpenCodeProviderOptions } from "./src/declaration.js";

function registeredDeclaration() {
  const host = createFakePluginHost({ pluginId: "provider-opencode" });
  opencodePlugin(host.bb);
  const declaration = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === "opencode",
  );
  if (declaration === undefined) {
    throw new Error("expected opencode to be registered");
  }
  return { host, declaration };
}

function rootPaths(
  side: readonly (string | { readonly path: string })[] | undefined,
): string[] {
  return (side ?? []).map((root) =>
    typeof root === "string" ? root : root.path,
  );
}

describe("the OpenCode plugin", () => {
  it("registers the native provider as always visible with workspace models", () => {
    const { declaration } = registeredDeclaration();
    expect(declaration.id).toBe("opencode");
    expect(declaration.displayName).toBe("OpenCode v2");
    expect(declaration.experimental_visibility ?? "always").toBe("always");
    expect(declaration.strings?.installUrl).toBe(
      "https://www.npmjs.com/package/shuvcode",
    );
    expect(declaration.strings?.signInHint).toContain("shuvcode auth login");
    expect(declaration.strings?.signInHint).toContain("opencode auth login");
    expect(declaration.strings?.expiredHint).toContain("shuvcode auth login");
    expect(declaration.strings?.expiredHint).toContain("opencode auth login");
    expect(declaration.models).toEqual({ scope: "workspace" });
    expect(declaration.family).toBeUndefined();
    expect(declaration.maintenance).toEqual({
      health: true,
      usage: false,
      installation: true,
    });
    expect(declaration.composerActions).toEqual([]);
    expect(declaration.capabilities.fork).toBe("checkpoint");
    expect(declaration.capabilities.supportsNativeUserQuestion).toBe(true);
    expect(declaration.capabilities.supportsThreadArchive).toBe(false);
    expect(declaration.capabilities.supportsThreadRename).toBe(true);
    expect(declaration.capabilities.permissionModes).toEqual([
      "accept-edits",
      "auto",
      "full",
    ]);
  });

  it("declares OpenCode env passthrough and defaultAgent plus defaultVariant", () => {
    const { host, declaration } = registeredDeclaration();
    expect(declaration.env).toEqual({
      passthrough: [
        "OPENCODE_SERVER_URL",
        "OPENCODE_SERVER_PASSWORD",
        "OPENCODE_APP",
      ],
    });
    expect(host.harness.registrations.settingsDescriptors).toMatchObject({
      defaultAgent: {
        type: "string",
        default: "",
      },
      defaultVariant: {
        type: "string",
        default: "",
      },
      bbToolsRequired: {
        type: "boolean",
        default: false,
      },
    });
  });

  it("declares recursive skill roots and filesystem command fallback", () => {
    const { declaration } = registeredDeclaration();
    expect(rootPaths(declaration.experimental_nativeSkillRoots?.user)).toEqual([
      ".claude/skills",
      ".agents/skills",
    ]);
    expect(
      rootPaths(declaration.experimental_nativeSkillRoots?.project),
    ).toEqual([".opencode/skills", ".claude/skills", ".agents/skills"]);
    expect(
      rootPaths(declaration.experimental_nativeCommandRoots?.project),
    ).toEqual([".opencode/commands", ".opencode/command"]);
    expect(declaration.experimental_resolvesNativeRoots).toBe(true);
  });
});

describe("deriveOpenCodeProviderOptions", () => {
  it("treats a leftover plan prompt as the default agent and still forwards variant", () => {
    expect(
      deriveOpenCodeProviderOptions({
        threadId: "thr_1",
        projectId: "prj_1",
        model: "google/gemini-3.7-flash-high",
        permissionMode: "accept-edits",
        promptMode: "plan",
        settings: { defaultAgent: "reviewer", defaultVariant: "thinking" },
      }),
    ).toEqual({ agent: "reviewer", variant: "thinking", bbToolsRequired: false });
    expect(
      deriveOpenCodeProviderOptions({
        threadId: "thr_1",
        projectId: "prj_1",
        model: "google/gemini-3.7-flash-high",
        permissionMode: "accept-edits",
        promptMode: "plan",
        settings: {},
      }),
    ).toEqual({ agent: null, variant: null, bbToolsRequired: false });
  });

  it("leaves blank defaultAgent and defaultVariant as null so the bridge resolves them", () => {
    expect(
      deriveOpenCodeProviderOptions({
        threadId: "thr_1",
        projectId: "prj_1",
        model: "google/gemini-3.7-flash-high",
        permissionMode: "accept-edits",
        settings: { defaultAgent: "  ", defaultVariant: "" },
      }),
    ).toEqual({ agent: null, variant: null, bbToolsRequired: false });
    expect(
      deriveOpenCodeProviderOptions({
        threadId: "thr_1",
        projectId: "prj_1",
        model: "google/gemini-3.7-flash-high",
        permissionMode: "accept-edits",
        settings: {},
      }),
    ).toEqual({ agent: null, variant: null, bbToolsRequired: false });
  });

  it("passes a named defaultAgent and catalog defaultVariant through", () => {
    expect(
      deriveOpenCodeProviderOptions({
        threadId: "thr_1",
        projectId: "prj_1",
        model: "google/gemini-3.7-flash-high",
        permissionMode: "full",
        settings: { defaultAgent: "reviewer", defaultVariant: "minimal" },
      }),
    ).toEqual({ agent: "reviewer", variant: "minimal", bbToolsRequired: false });
  });
});
