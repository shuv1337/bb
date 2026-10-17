import {
  getAppSettings,
  getDisabledProviderIds,
  getPluginSettingsValues,
  setAppSettings,
  setDisabledProviderIds,
  setPluginSettingsValues,
  type DbConnection,
} from "@bb/db";

export function migrateLegacyAcpSuppression(db: DbConnection): void {
  db.transaction(() => {
    const legacy = getPluginSettingsValues(db, "provider-acp").enableOpenCode;
    if (legacy === undefined) return;
    if (legacy === "false") {
      setDisabledProviderIds(db, [
        ...new Set([...getDisabledProviderIds(db), "acp-opencode"]),
      ]);
      const current = getAppSettings(db);
      if (current.defaultProviderId === "acp-opencode") {
        setAppSettings(db, { ...current, defaultProviderId: null });
      }
    }
    setPluginSettingsValues(db, "provider-acp", { enableOpenCode: null });
  });
}
