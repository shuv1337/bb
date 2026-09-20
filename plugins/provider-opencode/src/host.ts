import { homedir } from "node:os";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
  type ExperimentalNativeRootsResolveAnswer,
} from "@get-bb/plugin-sdk/host";
import { createOpenCodeRuntime } from "./runtime/index.js";
import {
  resolveOpenCodeNativeRoots,
  type OpenCodeCatalogSkill,
} from "./native-roots.js";

export { experimental_providerBridge } from "./bridge/bridge.js";

export type OpenCodeHostDiscovery = {
  appId: string | null;
  catalogSkills: readonly OpenCodeCatalogSkill[];
};

export async function loadOpenCodeHostDiscovery(args: {
  cwd: string | null;
  env: NodeJS.ProcessEnv;
  homedir: string;
}): Promise<OpenCodeHostDiscovery> {
  const runtime = await createOpenCodeRuntime({
    env: args.env,
    homedir: args.homedir,
  });
  try {
    const health = await runtime.health();
    const appId = health.appId;
    if (health.status !== "ready" || args.cwd === null) {
      return { appId, catalogSkills: [] };
    }
    const skills = await runtime.skills({ directory: args.cwd });
    return {
      appId,
      catalogSkills: skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        path: skill.path,
      })),
    };
  } catch {
    return { appId: null, catalogSkills: [] };
  } finally {
    await runtime.close();
  }
}

export async function resolveOpenCodeHostNativeRoots(args: {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string | null;
  discovery: OpenCodeHostDiscovery;
}): Promise<ExperimentalNativeRootsResolveAnswer> {
  return resolveOpenCodeNativeRoots({
    homeDir: args.homeDir,
    env: args.env,
    cwd: args.cwd,
    appId: args.discovery.appId ?? undefined,
    catalogSkills: args.discovery.catalogSkills,
  });
}

export default experimental_defineHostEntry({
  contract: experimental_nativeRootsHostContract,
  handlers: {
    resolveNativeRoots: async (input) => {
      const homeDir = homedir();
      const env = process.env;
      const discovery = await loadOpenCodeHostDiscovery({
        cwd: input.cwd,
        env,
        homedir: homeDir,
      });
      return resolveOpenCodeHostNativeRoots({
        homeDir,
        env,
        cwd: input.cwd,
        discovery,
      });
    },
  },
});
