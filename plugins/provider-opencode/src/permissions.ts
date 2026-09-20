import type {
  OpenCodePermissionMode,
  OpenCodePermissionRule,
} from "./runtime/types.js";

const SENSITIVE_AFTER: readonly OpenCodePermissionRule[] = [
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "edit", resource: "*.env", effect: "ask" },
  { action: "edit", resource: "*.env.*", effect: "ask" },
];

export function sessionRulesForPermissionMode(
  mode: OpenCodePermissionMode,
): OpenCodePermissionRule[] {
  if (mode === "full") {
    return [{ action: "*", resource: "*", effect: "allow" }];
  }
  if (mode === "auto") {
    return [
      { action: "*", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      ...SENSITIVE_AFTER,
    ];
  }
  return [
    { action: "*", resource: "*", effect: "ask" },
    { action: "edit", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "ask" },
    ...SENSITIVE_AFTER,
  ];
}
