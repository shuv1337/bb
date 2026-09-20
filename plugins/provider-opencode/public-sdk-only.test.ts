import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly as scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

const scan = scanPublicSdkOnly(dirname(fileURLToPath(import.meta.url)), {
  allow: [
    /^@opencode\/client(?:\/promise|\/service)$/u,
    /^(?:\.\.\/)+vitest\.shared\.js$/u,
  ],
});

describe("provider-opencode imports only the public SDK", () => {
  it("scans the plugin's source files", () => {
    expect(scan.files).toContain("server.ts");
    expect(scan.files).toContain(join("src", "host.ts"));
    expect(scan.files).toContain(join("src", "declaration.ts"));
    expect(scan.files).toContain(join("src", "native-roots.ts"));
    expect(scan.files).toContain(
      join("src", "bridge", "provider-maintenance.ts"),
    );
  });

  it("has no @bb/* import and stays inside the allowlist", () => {
    expect(scan.violations).toEqual([]);
  });

  it("allows only the bundled build tool as a private dev dependency", () => {
    expect(scan.privateDependencies).toEqual(["@bb/plugin-build"]);
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    );
    expect(manifest).toMatchObject({
      dependencies: { "@opencode/client": "2.0.10" },
      devDependencies: { "@bb/plugin-build": "workspace:*" },
    });
  });
});
