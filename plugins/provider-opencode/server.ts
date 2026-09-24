import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { BB_TOOLS_REQUIRED_SETTING } from "./src/bb-tools-required.js";
import {
  companionStatusSchema,
  formatCompanionStatus,
  openCodeHostContract,
  opencodeToolsRpcContract,
} from "./src/companion-status-contract.js";
import { opencodeProviderDeclaration } from "./src/declaration.js";

export { opencodeToolsRpcContract };

export default function plugin(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    defaultAgent: {
      type: "string",
      label: "Default agent",
      description:
        "OpenCode agent for new threads. Leave empty to use OpenCode's default_agent.",
      default: "",
    },
    defaultVariant: {
      type: "string",
      label: "Default variant",
      description:
        "OpenCode model variant id from the native catalog (thinking, minimal, high, …). Leave empty for the model's native default. A picker reasoning level overrides this. Variant none is sent only when the catalog lists it.",
      default: "",
    },
    [BB_TOOLS_REQUIRED_SETTING]: {
      type: "boolean",
      label: "bb tools required",
      description:
        "Global setting for every machine. Fail the turn when the companion is absent. Off keeps native-only threads and a setup warning. An incompatible companion fails the turn either way.",
      default: false,
    },
  });
  const host = bb.hosts.experimental_client({
    contract: openCodeHostContract,
  });

  async function companionStatus(machineId: string) {
    const values = await settings.get();
    const probe = await host.call("readCompanionStatus", {}, { hostId: machineId });
    return companionStatusSchema.parse({
      ...probe,
      machineId,
      bbToolsRequired: values.bbToolsRequired === true,
    });
  }

  bb.rpc.register(opencodeToolsRpcContract, {
    companionStatus: (input) => companionStatus(input.machineId),
  });

  bb.cli.register(
    defineCli({
      name: "opencode",
      summary: "OpenCode provider tools",
      description:
        "Read bb tools companion status for a machine. bb does not install the companion.",
      commands: {
        "tools status": cliCommand({
          summary: "Show bb tools companion status on a machine",
          options: {
            machine: {
              type: "string",
              required: true,
              description: "Machine id",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          async run(input) {
            const machineId = input.options.machine;
            const hosts = await bb.sdk.hosts.list();
            if (!hosts.some((entry) => entry.id === machineId)) {
              throw new PluginCliError(`No machine ${machineId}`, {
                code: "unknown_machine",
                hint: "Run `bb machine list` and pass that id to --machine.",
              });
            }
            const status = await companionStatus(machineId);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(status)
                : formatCompanionStatus(status),
            };
          },
        }),
      },
    }),
  );

  const registered = bb.providers.register(opencodeProviderDeclaration());
  bb.onDispose(() => {
    registered.dispose();
  });
}
