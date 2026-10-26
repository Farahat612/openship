import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("OPENSHIP_TARGET", "local");
  vi.stubEnv("CLOUD_MODE", "false");
  vi.stubEnv("DEPLOY_MODE", "docker");
  vi.stubEnv("INTERNAL_TOKEN", "test-internal-token-0000000000000000000000000000");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("OIDC issuer boot validation", () => {
  it("rejects a non-loopback http issuer in production at import", async () => {
    vi.stubEnv("OIDC_ISSUER", "http://idp.example.com");
    await expect(import("@repo/platform/engine/config/env")).rejects.toThrow(
      "OIDC_ISSUER must use https when NODE_ENV is production",
    );
  });

  it.each(["http://localhost:9000", "https://idp.example.com"])(
    "accepts %s in production at import", async (issuer) => {
      vi.stubEnv("OIDC_ISSUER", issuer);
      const { env } = await import("@repo/platform/engine/config/env");
      expect(env.NODE_ENV).toBe("production");
      expect(env.OIDC_ISSUER).toBe(issuer);
    },
  );
});
