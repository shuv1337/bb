import { homedir } from "node:os";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
  type ExperimentalNativeRootsResolveAnswer,
} from "@get-bb/plugin-sdk/host";
import { createOpenCodeRuntime } from "./runtime/index.js";
import {
  createOpenCodeCommandCatalogStore,
  resolveOpenCodeNativeRoots,
  type OpenCodeCatalogCommand,
  type OpenCodeCatalogSkill,
  type OpenCodeCommandCatalogStore,
} from "./native-roots.js";

export { experimental_providerBridge } from "./bridge/bridge.js";

export type OpenCodeHostDiscovery = {
  appId: string | null;
  catalogSkills: readonly OpenCodeCatalogSkill[];
  catalogCommands: readonly OpenCodeCatalogCommand[] | null;
};

function catalogCommandsFrom(
  commands: readonly { name: string; description?: string }[],
): OpenCodeCatalogCommand[] {
  return commands.map((command) => {
    const description = command.description?.trim();
    return description !== undefined && description.length > 0
      ? { name: command.name, description }
      : { name: command.name };
  });
}

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
      return { appId, catalogSkills: [], catalogCommands: null };
    }
    const [skillsResult, commandsResult] = await Promise.allSettled([
      runtime.skills({ directory: args.cwd }),
      runtime.commands({ directory: args.cwd }),
    ]);
    return {
      appId,
      catalogSkills:
        skillsResult.status === "fulfilled"
          ? skillsResult.value.map((skill) => ({
              id: skill.id,
              name: skill.name,
              path: skill.path,
            }))
          : [],
      catalogCommands:
        commandsResult.status === "fulfilled"
          ? catalogCommandsFrom(commandsResult.value)
          : null,
    };
  } catch {
    return { appId: null, catalogSkills: [], catalogCommands: null };
  } finally {
    await runtime.close();
  }
}

export async function resolveOpenCodeHostNativeRoots(args: {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string | null;
  discovery: OpenCodeHostDiscovery;
  commandCatalogStore: OpenCodeCommandCatalogStore;
}): Promise<ExperimentalNativeRootsResolveAnswer> {
  return resolveOpenCodeNativeRoots({
    homeDir: args.homeDir,
    env: args.env,
    cwd: args.cwd,
    appId: args.discovery.appId ?? undefined,
    catalogSkills: args.discovery.catalogSkills,
    commandCatalog:
      args.discovery.catalogCommands === null
        ? null
        : {
            commands: args.discovery.catalogCommands,
            store: args.commandCatalogStore,
          },
  });
}

export function createOpenCodeHostEntry() {
  let commandCatalogStore: OpenCodeCommandCatalogStore | null = null;
  return experimental_defineHostEntry({
    contract: experimental_nativeRootsHostContract,
    handlers: {
      resolveNativeRoots: async (input, context) => {
        const homeDir = homedir();
        const env = process.env;
        commandCatalogStore ??= createOpenCodeCommandCatalogStore({
          dataDir: context.experimental_paths.dataDir,
        });
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
          commandCatalogStore,
        });
      },
    },
    dispose: async () => {
      const store = commandCatalogStore;
      commandCatalogStore = null;
      await store?.dispose();
    },
  });
}

export default createOpenCodeHostEntry();
