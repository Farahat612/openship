import { describe, expect, it } from "vitest";
import type { SourceProvider } from "@repo/core";

import {
  repoIsGithubSource,
  resolveClonePlan,
  type ClonePlanInput,
} from "../../../src/modules/deployments/clone-plan";

const base: ClonePlanInput = {
  effectiveTarget: "server",
  serverId: "srv_1",
  runtimeIsBare: false,
  cloneStrategy: "api-host",
  buildStrategy: "server",
  isDesktop: false,
  forwardGitCredentials: false,
};

describe("resolveClonePlan", () => {
  it("local build → clone runs locally with a local credential", () => {
    const plan = resolveClonePlan({ ...base, effectiveTarget: "server", buildStrategy: "local" });
    expect(plan.runsOnServer).toBe(false);
    expect(plan.runsLocally).toBe(true);
    expect(plan.cloneBuildStrategy).toBe("local");
  });

  it("docker + server + api-host clone → api-host clone (local credential), not on server", () => {
    const plan = resolveClonePlan({ ...base, cloneStrategy: "api-host" });
    expect(plan.runsOnServer).toBe(false);
    expect(plan.runsLocally).toBe(true);
    expect(plan.cloneBuildStrategy).toBe("local");
  });

  it("docker + server + clone-on-server → on-server clone with a shippable (server) credential", () => {
    const plan = resolveClonePlan({ ...base, cloneStrategy: "server" });
    expect(plan.runsOnServer).toBe(true);
    expect(plan.dockerClonesOnServer).toBe(true);
    expect(plan.runsLocally).toBe(false);
    expect(plan.cloneBuildStrategy).toBe("server");
    expect(plan.relayEligible).toBe(false); // non-desktop
  });

  it("bare + server → always clones on the server with a server credential", () => {
    const plan = resolveClonePlan({ ...base, runtimeIsBare: true, cloneStrategy: "api-host" });
    expect(plan.runsOnServer).toBe(true);
    expect(plan.dockerClonesOnServer).toBe(false); // bare excluded from the docker warn-case
    expect(plan.cloneBuildStrategy).toBe("server");
  });

  it("SECURITY: contradictory buildStrategy=local + cloneStrategy=server never emits a LOCAL credential for an on-server clone", () => {
    const plan = resolveClonePlan({ ...base, cloneStrategy: "server", buildStrategy: "local" });
    // The clone physically runs on the remote server...
    expect(plan.runsOnServer).toBe(true);
    // ...so the credential purpose MUST be "server" (shippable) — never "local",
    // which would ship the operator's broad gh/OAuth token off-host.
    expect(plan.runsLocally).toBe(false);
    expect(plan.cloneBuildStrategy).toBe("server");
  });

  it("desktop + forwardGitCredentials + on-server clone → relay eligible", () => {
    const plan = resolveClonePlan({
      ...base,
      cloneStrategy: "server",
      isDesktop: true,
      forwardGitCredentials: true,
    });
    expect(plan.runsOnServer).toBe(true);
    expect(plan.relayEligible).toBe(true);
  });

  it("cloud target without a local build → off-host clone needs a remote credential", () => {
    const plan = resolveClonePlan({
      ...base,
      effectiveTarget: "cloud",
      serverId: null,
      buildStrategy: "server",
    });
    expect(plan.runsOnServer).toBe(false);
    expect(plan.runsLocally).toBe(false);
    expect(plan.cloneBuildStrategy).toBe("server");
  });

  /**
   * #346 — a LOCAL target has no server to clone on, so the clone always runs on
   * this host and must use a LOCAL credential, whatever buildStrategy says.
   *
   * This is not a hypothetical: no stack declares `defaultBuildStrategy`, so
   * `resolveStrategy` returns "server" for every caller that omits it. The
   * dashboard always sends it explicitly and so never hit this; MCP, the CLI, CI
   * and webhooks don't, and got a clone tagged "server" for a local deploy —
   * which refuses gh-cli (not shippable) and hard-failed with "No GitHub token
   * available … (purpose: remote)" on a box that could clone perfectly well.
   */
  describe("local target — clone always runs on this host", () => {
    const localBase: ClonePlanInput = { ...base, effectiveTarget: "local", serverId: null };

    it("defaulted buildStrategy=server still clones locally with a local credential", () => {
      const plan = resolveClonePlan({ ...localBase, buildStrategy: "server" });
      expect(plan.runsOnServer).toBe(false);
      expect(plan.runsLocally).toBe(true);
      expect(plan.cloneBuildStrategy).toBe("local");
    });

    it("explicit buildStrategy=local is unchanged", () => {
      const plan = resolveClonePlan({ ...localBase, buildStrategy: "local" });
      expect(plan.runsLocally).toBe(true);
      expect(plan.cloneBuildStrategy).toBe("local");
    });

    it("a bare runtime on a local target does not become an on-server clone", () => {
      // runsOnServer requires effectiveTarget==="server" AND a serverId; bare only
      // forces on-server WITHIN that. A local target has neither.
      const plan = resolveClonePlan({ ...localBase, runtimeIsBare: true });
      expect(plan.runsOnServer).toBe(false);
      expect(plan.cloneBuildStrategy).toBe("local");
    });

    it("never relay-eligible: there is no remote build host to forward to", () => {
      const plan = resolveClonePlan({
        ...localBase,
        isDesktop: true,
        forwardGitCredentials: true,
      });
      expect(plan.relayEligible).toBe(false);
    });
  });
});

/**
 * The GitHub tarball fast path is now gated on the PROVIDER column, not on
 * "there is a gitOwner". Every existing row must answer exactly as it did
 * before — the change may only re-answer rows that were already broken (a
 * github row with nothing to fetch) or that cannot exist yet (a non-github
 * remote carrying an owner).
 */
describe("repoIsGithubSource — the tarball fast-path gate", () => {
  /** A project row, as preflight and the pipeline see it. */
  type Row = {
    gitProvider: SourceProvider | null;
    gitOwner: string | null;
    /** `resolveSourceRemote(project)` → `snapshot.repoUrl`. */
    repoUrl: string;
  };

  /**
   * Exactly what both call sites now pass. Swap this body for the PRE-change
   * rule — `!!row.gitOwner` — to see which of the cases below the old
   * derivation got wrong; every `gitOwner` here is populated for that reason.
   */
  const gate = (row: Row) =>
    repoIsGithubSource({ gitProvider: row.gitProvider, repoUrl: row.repoUrl });

  const GH: Row = {
    gitProvider: "github",
    gitOwner: "oblien",
    repoUrl: "https://github.com/oblien/openship.git",
  };

  it("github provider + a remote → true (the fast path, unchanged)", () => {
    expect(gate(GH)).toBe(true);
  });

  it("local / upload / release rows → false (unchanged: they never had a remote)", () => {
    // gitOwner survives a localPath flip, so the old rule answered TRUE for the
    // first of these — a directory-deployed project opted into an on-server
    // source acquisition it has no source for.
    expect(gate({ gitProvider: "local", gitOwner: "oblien", repoUrl: "" })).toBe(false);
    expect(gate({ gitProvider: "upload", gitOwner: null, repoUrl: "" })).toBe(false);
    expect(gate({ gitProvider: "release", gitOwner: null, repoUrl: "" })).toBe(false);
  });

  it("a NON-github remote is never sent to github's tarball endpoint", () => {
    // The old `!!gitOwner` rule says TRUE for both of these the moment a
    // GitLab/Bitbucket project populates gitOwner — the bug this gate prevents.
    expect(
      gate({ gitProvider: "gitlab", gitOwner: "group", repoUrl: "https://gitlab.com/g/app.git" }),
    ).toBe(false);
    expect(
      gate({
        gitProvider: "bitbucket",
        gitOwner: "team",
        repoUrl: "https://bitbucket.org/team/a.git",
      }),
    ).toBe(false);
  });

  it("a github row with NO remote → false (adopted-docker / image-only project)", () => {
    // gitProvider defaults to "github" on a project reconstructed from live
    // containers; it has no source to acquire, so it must not opt into an
    // on-server acquisition of nothing.
    for (const repoUrl of ["", "   "]) {
      expect(gate({ gitProvider: "github", gitOwner: null, repoUrl })).toBe(false);
    }
    expect(repoIsGithubSource({ gitProvider: "github" })).toBe(false);
    expect(repoIsGithubSource({ gitProvider: "github", repoUrl: null })).toBe(false);
  });

  it("a NULL provider column still counts as github (legacy rows keep the fast path)", () => {
    // The column defaults to "github" and rows predating it read back null —
    // those ARE github projects, and `resolveSourceRemote` built their URL on
    // the same assumption. Reading the column differently here would silently
    // demote them to an orchestrator clone.
    expect(gate({ ...GH, gitProvider: null })).toBe(true);
    expect(repoIsGithubSource({ repoUrl: GH.repoUrl })).toBe(true);
    // …but a null provider with nothing to fetch is still false.
    expect(gate({ gitProvider: null, gitOwner: "oblien", repoUrl: "" })).toBe(false);
  });

  it("feeds the plan: a github repo makes docker acquire on the server without the opt-in", () => {
    const plan = (row: Row): ClonePlanInput => ({
      ...base,
      cloneStrategy: "api-host",
      repoIsGithub: gate(row),
    });

    expect(resolveClonePlan(plan(GH)).dockerClonesOnServer).toBe(true);
    // Not a github remote → no tarball fast path → the orchestrator clones and
    // transfers the context, exactly like a local/imported project today.
    expect(
      resolveClonePlan(
        plan({ gitProvider: "gitlab", gitOwner: "group", repoUrl: "https://gitlab.com/g/app.git" }),
      ).dockerClonesOnServer,
    ).toBe(false);
  });
});
