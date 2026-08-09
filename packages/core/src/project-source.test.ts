import { describe, expect, it } from "vitest";

import {
  asRemoteGitUrl,
  githubCloneUrl,
  isGithubProvider,
  resolveSourceRemote,
} from "./project-source";

describe("isGithubProvider", () => {
  it("is true for github and for the legacy NULL column", () => {
    expect(isGithubProvider("github")).toBe(true);
    expect(isGithubProvider(null)).toBe(true);
    expect(isGithubProvider(undefined)).toBe(true);
  });

  it("is false for every other checked provider", () => {
    for (const p of ["gitlab", "bitbucket", "local", "upload", "release"] as const) {
      expect(isGithubProvider(p)).toBe(false);
    }
  });
});

describe("githubCloneUrl", () => {
  it("builds the github https remote from owner + repo", () => {
    expect(githubCloneUrl("oblien", "openship")).toBe("https://github.com/oblien/openship.git");
  });

  it("is undefined without both halves", () => {
    expect(githubCloneUrl("oblien", null)).toBeUndefined();
    expect(githubCloneUrl(null, "openship")).toBeUndefined();
    expect(githubCloneUrl(undefined, undefined)).toBeUndefined();
  });
});

describe("resolveSourceRemote", () => {
  it("prefers the STORED remote over the github builder", () => {
    expect(
      resolveSourceRemote({
        gitProvider: "github",
        gitUrl: "https://git.example.com/team/app.git",
        gitOwner: "oblien",
        gitRepo: "openship",
      }),
    ).toBe("https://git.example.com/team/app.git");
  });

  it("returns a non-github stored remote untouched", () => {
    expect(
      resolveSourceRemote({
        gitProvider: "gitlab",
        gitUrl: "https://gitlab.com/group/sub/app.git",
      }),
    ).toBe("https://gitlab.com/group/sub/app.git");
  });

  it("falls back to the github builder for a github row with no stored url", () => {
    expect(
      resolveSourceRemote({ gitProvider: "github", gitUrl: null, gitOwner: "o", gitRepo: "r" }),
    ).toBe("https://github.com/o/r.git");
  });

  it("falls back for a legacy row with NO provider (column default is github)", () => {
    expect(resolveSourceRemote({ gitOwner: "o", gitRepo: "r" })).toBe("https://github.com/o/r.git");
  });

  it("does NOT conjure a github remote for a non-github provider", () => {
    // A `localPath` ensure sets gitProvider="local" and NULLs gitUrl, but leaves
    // the old gitOwner/gitRepo behind — rebuilding from them would give a
    // directory-deployed project a repo to clone.
    expect(
      resolveSourceRemote({ gitProvider: "local", gitUrl: null, gitOwner: "o", gitRepo: "r" }),
    ).toBeUndefined();
    expect(
      resolveSourceRemote({ gitProvider: "release", gitOwner: "o", gitRepo: "r" }),
    ).toBeUndefined();
    expect(
      resolveSourceRemote({ gitProvider: "gitlab", gitOwner: "o", gitRepo: "r" }),
    ).toBeUndefined();
  });

  it("treats a blank stored url as absent", () => {
    expect(
      resolveSourceRemote({ gitProvider: "github", gitUrl: "   ", gitOwner: "o", gitRepo: "r" }),
    ).toBe("https://github.com/o/r.git");
  });
});

describe("asRemoteGitUrl", () => {
  it("accepts an https remote on any host", () => {
    expect(asRemoteGitUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(asRemoteGitUrl("https://gitlab.example.com/group/app.git")).toBe(
      "https://gitlab.example.com/group/app.git",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(asRemoteGitUrl("  https://github.com/o/r.git\n")).toBe("https://github.com/o/r.git");
  });

  it("rejects a non-string / empty value", () => {
    expect(asRemoteGitUrl(undefined)).toBeNull();
    expect(asRemoteGitUrl(null)).toBeNull();
    expect(asRemoteGitUrl(42)).toBeNull();
    expect(asRemoteGitUrl("   ")).toBeNull();
  });

  it("rejects every non-https scheme", () => {
    expect(asRemoteGitUrl("http://github.com/o/r.git")).toBeNull();
    expect(asRemoteGitUrl("ssh://git@github.com/o/r.git")).toBeNull();
    expect(asRemoteGitUrl("git@github.com:o/r.git")).toBeNull();
    expect(asRemoteGitUrl("file:///etc/passwd")).toBeNull();
    expect(asRemoteGitUrl("ext::sh -c whoami")).toBeNull();
  });

  it("rejects embedded credentials (they would be persisted + logged)", () => {
    expect(asRemoteGitUrl("https://x-access-token:ghs_secret@github.com/o/r.git")).toBeNull();
    expect(asRemoteGitUrl("https://user@github.com/o/r.git")).toBeNull();
  });

  it("rejects an option-like value git would read as a flag", () => {
    expect(asRemoteGitUrl("--upload-pack=touch /tmp/pwned")).toBeNull();
  });

  it("rejects an absurdly long value", () => {
    expect(asRemoteGitUrl(`https://github.com/o/${"r".repeat(600)}.git`)).toBeNull();
  });
});
