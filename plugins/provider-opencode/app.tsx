import { useEffect, useState } from "react";
import {
  definePluginApp,
  UrlLink,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import {
  COMPANION_PACKAGE_NAME,
  COMPANION_REPOSITORY_URL,
} from "./src/companion-install.js";
import {
  opencodeToolsRpcContract,
  type CompanionStatus,
} from "./src/companion-status-contract.js";

type MachineRow = {
  id: string;
  name: string;
  status: "connected" | "disconnected";
};

function isMachineRow(value: unknown): value is MachineRow {
  if (value === null || typeof value !== "object") return false;
  const id = Reflect.get(value, "id");
  const name = Reflect.get(value, "name");
  const status = Reflect.get(value, "status");
  return (
    typeof id === "string" &&
    typeof name === "string" &&
    (status === "connected" || status === "disconnected")
  );
}

function StatusLine(props: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="text-foreground">{props.value}</span>
    </div>
  );
}

function MachineStatus(props: { name: string; status: CompanionStatus }) {
  const status = props.status;
  const version =
    status.package.version === null ? "unknown" : status.package.version;
  const range = status.protocol.versions;
  const protocol =
    range === null
      ? status.protocol.legacyVersion === null
        ? "unknown"
        : `${status.protocol.legacyVersion} (range unknown)`
      : `${range.min}–${range.max}`;
  const overlap =
    status.protocol.overlapsSupported === null
      ? "unknown"
      : status.protocol.overlapsSupported
        ? "overlaps 1–1"
        : "outside 1–1";
  return (
    <div className="space-y-1 border-t border-border pt-3">
      <p className="text-sm text-foreground">{props.name}</p>
      <StatusLine
        label="Companion"
        value={status.detected ? version : "not installed"}
      />
      {status.reason !== null ? (
        <p className="text-sm text-foreground">{status.reason}</p>
      ) : null}
      {status.detected ? (
        <StatusLine label="Protocol" value={`${protocol}, ${overlap}`} />
      ) : null}
      {status.install.path !== null ? (
        <StatusLine label="Path" value={status.install.path} />
      ) : null}
      {status.install.digest !== null ? (
        <StatusLine label="Digest" value={status.install.digest} />
      ) : null}
      {status.instances !== null ? (
        <StatusLine label="Instances" value={String(status.instances)} />
      ) : null}
      {status.richFailures !== null ? (
        <StatusLine
          label="Rich failures"
          value={status.richFailures ? "yes" : "no"}
        />
      ) : null}
      {status.duplicates
        ? status.pluginSpecs.map((spec) => (
            <p key={`${spec.id ?? ""}:${spec.spec}`} className="text-sm text-foreground">
              {spec.spec}
            </p>
          ))
        : null}
      {status.engine.installCommands.map((command) => (
        <p key={command} className="text-sm text-foreground">
          {command}
        </p>
      ))}
      {!status.detected && status.bbToolsRequired ? (
        <p className="text-sm text-foreground">Turns fail until the companion is installed.</p>
      ) : null}
    </div>
  );
}

function CompanionStatusPanel() {
  const sdk = useSdk();
  const rpc = useRpc<typeof opencodeToolsRpcContract>();
  const [machines, setMachines] = useState<MachineRow[] | null>(null);
  const [statuses, setStatuses] = useState<CompanionStatus[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void sdk.hosts.list().then(
      (listed) => {
        if (!active) return;
        const rows = listed.filter(isMachineRow);
        setMachines(rows);
        const connected = rows.filter((row) => row.status === "connected");
        void Promise.all(
          connected.map((row) =>
            rpc.call("companionStatus", { machineId: row.id }),
          ),
        ).then(
          (next) => {
            if (!active) return;
            setStatuses(next);
            setError(null);
          },
          (loadError: unknown) => {
            if (!active) return;
            setError(
              loadError instanceof Error ? loadError.message : String(loadError),
            );
          },
        );
      },
      (loadError: unknown) => {
        if (!active) return;
        setError(
          loadError instanceof Error ? loadError.message : String(loadError),
        );
        setMachines([]);
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, sdk]);

  return (
    <div className="space-y-3 text-sm">
      <UrlLink href={COMPANION_REPOSITORY_URL}>{COMPANION_PACKAGE_NAME}</UrlLink>
      {error !== null ? <p className="text-foreground">{error}</p> : null}
      {machines === null ? <p className="text-muted-foreground">Loading</p> : null}
      {machines?.filter((row) => row.status === "disconnected").map((row) => (
        <p key={row.id} className="text-sm text-muted-foreground">
          {row.name} offline
        </p>
      ))}
      {statuses.map((status) => (
        <MachineStatus
          key={status.machineId}
          name={
            machines?.find((row) => row.id === status.machineId)?.name ??
            status.machineId
          }
          status={status}
        />
      ))}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "bb-tools",
    title: "bb tools companion",
    description: "Native bb tools need the separate OpenCode plugin.",
    component: CompanionStatusPanel,
  });
});
