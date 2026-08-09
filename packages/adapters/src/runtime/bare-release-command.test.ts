import { describe, expect, it, vi } from "vitest";
import { BareRuntime } from "./bare";
import type { CommandExecutor, DeployConfig } from "../types";

/**
 * A bare release command runs in the STAGED artifact directory — the tree
 * `deploy` is about to promote — with the deploy's env exported, so a migration
 * sees the code it is migrating for and resolves its DSN exactly as the app
 * will. It runs BEFORE anything is promoted or started, so a non-zero exit must
 * surface as a throw: that is what fails the deploy while the previous release
 * is still the one serving.
 */
function makeExecutor(result: { code: number; output: string }) {
  const commands: string[] = [];
  const executor = {
    exec: vi.fn(async () => ""),
    streamExec: vi.fn(async (command: string) => {
      commands.push(command);
      return result;
    }),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ""),
    exists: vi.fn(async () => false),
    mkdir: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as CommandExecutor;
  return { executor, commands };
}

/** imageRef = the staged build directory, which is what bare hands `deploy`. */
function config(overrides: Partial<DeployConfig> = {}): DeployConfig {
  return {
    projectId: "proj_1",
    deploymentId: "dep_1",
    buildSessionId: "bs_1",
    imageRef: "/opt/openship/.builds/bs_1",
    environment: "production",
    port: 8000,
    envVars: { DATABASE_URL: "postgres://u:p@db/app", "not-an-ident": "x" },
    resources: { cpuCores: 0, memoryMb: 0, diskMb: 0 },
    ...overrides,
  } as unknown as DeployConfig;
}

describe("BareRuntime.runReleaseCommand", () => {
  // Same env as the supervised app, by construction (bareProcessEnv). On bare a
  // project PATH is worse than on docker: `export PATH=…` REPLACES the base, so
  // even `/usr/bin/env node` stops resolving.
  it("does not export a project-set PATH, exactly as deploy does, and says so", async () => {
    const { executor, commands } = makeExecutor({ code: 0, output: "" });
    const lines: Array<{ message: string; level?: string }> = [];
    await new BareRuntime({ executor }).runReleaseCommand(
      config({ envVars: { DATABASE_URL: "postgres://u:p@db/app", PATH: "/copied/from/heroku" } }),
      "php artisan migrate --force",
      (entry) => lines.push(entry),
    );
    expect(commands[0]).not.toContain("/copied/from/heroku");
    expect(commands[0]).toContain("export DATABASE_URL='postgres://u:p@db/app'");
    expect(lines.some((line) => line.level === "warn" && line.message.includes("PATH"))).toBe(true);
  });

  // `prisma migrate deploy` names a node_modules/.bin binary exactly the way
  // `next start` does; the start command gets that dir prepended (openship#623),
  // so the release command has to as well, or it exits 127 where the app runs.
  it("puts node_modules/.bin on PATH for a Node package manager, as the start command gets", async () => {
    const { executor, commands } = makeExecutor({ code: 0, output: "" });
    await new BareRuntime({ executor }).runReleaseCommand(
      config({ packageManager: "npm" } as Partial<DeployConfig>),
      "prisma migrate deploy",
      () => {},
    );
    expect(commands[0]).toMatch(
      /cd '\/opt\/openship\/\.builds\/bs_1' && export PATH='\/opt\/openship\/\.builds\/bs_1\/node_modules\/\.bin':"\$PATH" && prisma migrate deploy/,
    );
  });

  it("declares the capability", () => {
    expect(new BareRuntime({ executor: makeExecutor({ code: 0, output: "" }).executor }).supports("releaseCommand")).toBe(true);
  });

  it("runs in the staged release dir with the start command's env", async () => {
    const { executor, commands } = makeExecutor({ code: 0, output: "" });
    const runtime = new BareRuntime({ executor });
    await runtime.runReleaseCommand(config(), "php artisan migrate --force", () => {});

    expect(commands).toHaveLength(1);
    const command = commands[0]!;
    expect(command).toContain("cd '/opt/openship/.builds/bs_1' && php artisan migrate --force");
    expect(command).toContain("export DATABASE_URL='postgres://u:p@db/app'");
    // PORT/NODE_ENV are part of the start command's env, so they're part of this one.
    expect(command).toContain("export PORT='8000'");
    expect(command).toContain("export NODE_ENV='production'");
    // A key that isn't a shell identifier would break the export prefix outright.
    expect(command).not.toContain("not-an-ident");
  });

  // The whole gate: without this throw a failed migration deploys anyway.
  it("throws with the command's own output when it exits non-zero", async () => {
    const { executor } = makeExecutor({ code: 1, output: "SQLSTATE[42S02]: table not found" });
    const runtime = new BareRuntime({ executor });
    await expect(
      runtime.runReleaseCommand(config(), "php artisan migrate --force", () => {}),
    ).rejects.toThrow(/exit code 1[\s\S]*SQLSTATE\[42S02\]/);
  });

  // Bounded: an unbounded release command holds the deploy open forever with the
  // old version still serving. The abort's exit code must not be reported as the
  // failure — the timeout is the story.
  it("aborts and reports a timeout rather than the killed child's exit code", async () => {
    const executor = {
      exec: vi.fn(async () => ""),
      streamExec: vi.fn(
        (_command: string, _onLog: unknown, opts?: { signal?: AbortSignal }) =>
          new Promise<{ code: number; output: string }>((resolve) => {
            opts?.signal?.addEventListener("abort", () => resolve({ code: 143, output: "" }));
          }),
      ),
      writeFile: vi.fn(async () => {}),
      readFile: vi.fn(async () => ""),
      exists: vi.fn(async () => false),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } as unknown as CommandExecutor;
    const runtime = new BareRuntime({ executor });
    await expect(
      runtime.runReleaseCommand(config(), "sleep 999", () => {}, { timeoutMs: 20 }),
    ).rejects.toThrow(/timed out after/);
  });
});
