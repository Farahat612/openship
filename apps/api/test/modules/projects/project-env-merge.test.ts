import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_MASK } from "@repo/core";

/**
 * Project env merges must follow the same rules as service env merges: a value
 * sent back as the list mask keeps the stored secret, an upsert that omits
 * isSecret keeps the stored flag, and invalid names are refused. Otherwise an
 * API, CLI or SDK round trip through listEnvVars exposes or destroys secrets.
 */

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  listEnvVars: vi.fn(),
  mergeEnvVars: vi.fn(async () => {}),
  listByProject: vi.fn(async () => []),
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: h.findById, listEnvVars: h.listEnvVars, mergeEnvVars: h.mergeEnvVars },
    service: { listByProject: h.listByProject },
  },
}));

import { encrypt, decrypt } from "@repo/platform/engine/lib/encryption";
import { mergeEnvVars } from "@repo/platform/engine/modules/projects/project-env.service";

type Written = { key: string; value: string; isSecret?: boolean };

function storedRow(key: string, value: string, isSecret: boolean) {
  return { id: `env-${key}`, key, value: encrypt(value), isSecret, serviceId: null };
}

function written(): Written[] {
  const calls = h.mergeEnvVars.mock.calls as unknown as [string, string, Written[], string[]][];
  return calls[0]![2];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.findById.mockResolvedValue({ id: "p1", organizationId: "org1" });
  h.listEnvVars.mockResolvedValue([storedRow("API_KEY", "real-secret", true)]);
});

describe("project env merge", () => {
  it("keeps a stored secret secret when an upsert omits isSecret", async () => {
    await mergeEnvVars("p1", "org1", {
      environment: "production",
      upserts: [{ key: "API_KEY", value: "rotated" }],
      deletes: [],
    });
    expect(written()).toEqual([{ key: "API_KEY", value: expect.any(String), isSecret: true }]);
    expect(decrypt(written()[0]!.value)).toBe("rotated");
  });

  it("still lets an explicit isSecret false unmark a secret", async () => {
    await mergeEnvVars("p1", "org1", {
      environment: "production",
      upserts: [{ key: "API_KEY", value: "now-public", isSecret: false }],
      deletes: [],
    });
    expect(written()[0]!.isSecret).toBe(false);
  });

  it("keeps the stored value when the list mask is sent back", async () => {
    const before = (await h.listEnvVars())[0]!.value as string;
    await mergeEnvVars("p1", "org1", {
      environment: "production",
      upserts: [{ key: "API_KEY", value: ENV_MASK }],
      deletes: [],
    });
    expect(written()[0]!.value).toBe(before);
    expect(decrypt(written()[0]!.value)).toBe("real-secret");
  });

  it("refuses the mask for a key with no stored value", async () => {
    await expect(
      mergeEnvVars("p1", "org1", {
        environment: "production",
        upserts: [{ key: "NEW_TOKEN", value: ENV_MASK }],
        deletes: [],
      }),
    ).rejects.toThrow(/No saved value exists for "NEW_TOKEN"/);
    expect(h.mergeEnvVars).not.toHaveBeenCalled();
  });

  it("refuses invalid variable names before writing", async () => {
    for (const key of ["MY VAR=1", "1ST", "A-B"]) {
      await expect(
        mergeEnvVars("p1", "org1", {
          environment: "production",
          upserts: [{ key, value: "x" }],
          deletes: [],
        }),
      ).rejects.toThrow(/Invalid environment variable name/);
    }
    expect(h.mergeEnvVars).not.toHaveBeenCalled();
  });

  it("marks a new secret-looking key as secret when isSecret is omitted", async () => {
    h.listEnvVars.mockResolvedValue([]);
    await mergeEnvVars("p1", "org1", {
      environment: "production",
      upserts: [
        { key: "DATABASE_PASSWORD", value: "pw" },
        { key: "PUBLIC_URL", value: "https://example.com" },
      ],
      deletes: [],
    });
    expect(written().map((row) => [row.key, row.isSecret])).toEqual([
      ["DATABASE_PASSWORD", true],
      ["PUBLIC_URL", false],
    ]);
  });
});
