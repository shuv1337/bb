import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { opencodeProviderDeclaration } from "./src/declaration.js";

export default function plugin(bb: BbPluginApi): void {
  bb.settings.define({
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
  });
  const registered = bb.providers.register(opencodeProviderDeclaration());
  bb.onDispose(() => {
    registered.dispose();
  });
}
