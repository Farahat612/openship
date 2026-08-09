import { describe, it, expect } from "vitest";
import type { CommandExecutor } from "@repo/adapters";
import { readManifest, upsertProjectIntoManifest, type ManifestProjectEntry } from "./openship-manifest";
import { reconcileOpenshipProjects } from "../modules/migration/docker-reconcile";
import type { DockerContainerDetail } from "@repo/adapters";

/**
 * The manifest is how a project survives a lost orchestrator. It carried
 * owner/repo but NOT the remote, so re-import rebuilt
 * `https://github.com/<owner>/<repo>.git` — a non-GitHub project came back
 * pointed at github.com. These cover the round trip: what the sync writes, what
 * a fresh orchestrator reads back, and what it is allowed to persist.
 */

/** In-memory `.openship` — writeFile stores, `cat` returns. Enough for the
 *  read-merge-write path (upsert reads the file it just wrote). */
function fakeServer() {
  const files = new Map<string, string>();
  const exec: CommandExecutor = {
    exec: async (cmd: string) => {
      const cat = cmd.match(/^cat '([^']+)'/);
      if (cat) return files.get(cat[1]!) ?? "";
      const mv = cmd.match(/^mv -f '([^']+)' '([^']+)'/);
      if (mv) {
        files.set(mv[2]!, files.get(mv[1]!) ?? "");
        files.delete(mv[1]!);
      }
      return "";
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
    },
  } as unknown as CommandExecutor;
  return { exec, files };
}

function entry(over: Partial<ManifestProjectEntry> & { id: string }): ManifestProjectEntry {
  return {
    slug: "shop",
    name: "Shop",
    organizationId: "org_1",
    groupId: "app_1",
    domains: [],
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function container(labels: Record<string, string>): DockerContainerDetail {
  return {
    id: "c1",
    name: "web",
    image: "myapp:latest",
    imageId: "sha256:abc",
    state: "running",
    env: [],
    networks: [],
    mounts: [],
    ports: [],
    labels,
  } as unknown as DockerContainerDetail;
}

/** Reconcile one project from a single container + this manifest entry. */
function reconcileWith(e: ManifestProjectEntry) {
  return reconcileOpenshipProjects({
    managedDetails: [container({ "openship.project": e.id, "openship.service": "web" })],
    manifestById: new Map([[e.id, e]]),
    knownHereIds: new Set(),
    snapshotIds: new Set(),
  })[0]!;
}

describe("manifest round-trip — the project's remote", () => {
  it("carries gitUrl through write → read", async () => {
    const { exec } = fakeServer();
    await upsertProjectIntoManifest(
      exec,
      entry({
        id: "proj_abc",
        gitProvider: "gitlab",
        gitOwner: "group",
        gitRepo: "app",
        gitUrl: "https://gitlab.example.com/group/app.git",
      }),
    );

    const read = await readManifest(exec);
    expect(read?.projects).toHaveLength(1);
    expect(read!.projects[0]!.gitUrl).toBe("https://gitlab.example.com/group/app.git");
  });

  it("re-import keeps a NON-github remote instead of rebuilding a github one", async () => {
    const { exec } = fakeServer();
    await upsertProjectIntoManifest(
      exec,
      entry({
        id: "proj_abc",
        gitProvider: "gitlab",
        gitOwner: "group",
        gitRepo: "app",
        gitUrl: "https://gitlab.example.com/group/app.git",
      }),
    );
    const read = await readManifest(exec);

    const group = reconcileWith(read!.projects[0]!);
    expect(group.source).toMatchObject({
      gitProvider: "gitlab",
      gitUrl: "https://gitlab.example.com/group/app.git",
    });
    expect(group.source?.gitUrl).not.toContain("github.com");
  });

  it("a GitHub project round-trips byte-identically", async () => {
    const { exec } = fakeServer();
    await upsertProjectIntoManifest(
      exec,
      entry({
        id: "proj_gh",
        gitProvider: "github",
        gitOwner: "oblien",
        gitRepo: "openship",
        gitUrl: "https://github.com/oblien/openship.git",
      }),
    );
    const group = reconcileWith((await readManifest(exec))!.projects[0]!);
    expect(group.source).toEqual({
      gitProvider: "github",
      gitOwner: "oblien",
      gitRepo: "openship",
      gitBranch: undefined,
      gitUrl: "https://github.com/oblien/openship.git",
    });
  });

  it("a PRE-gitUrl manifest yields null → the caller rebuilds the GitHub URL, as before", () => {
    const group = reconcileWith(
      entry({ id: "proj_old", gitProvider: "github", gitOwner: "oblien", gitRepo: "openship" }),
    );
    expect(group.source?.gitUrl).toBeNull();
    expect(group.source?.gitOwner).toBe("oblien");
  });

  it("drops a hostile / unusable remote rather than persisting it", () => {
    // The manifest is JSON off a box we don't control and this value becomes a
    // `git clone` argument — each of these must never reach a project row.
    for (const bad of [
      "https://x-access-token:ghs_leaked@github.com/o/r.git", // embedded credential
      "ssh://git@evil.example.com/o/r.git", // unvetted host keys
      "file:///etc/passwd", // local file read on the build host
      "ext::sh -c id", // command execution
      "--upload-pack=touch /tmp/pwned", // git reads it as an option
      42, // not even a string
    ]) {
      const group = reconcileWith(
        entry({ id: "proj_bad", gitProvider: "github", gitOwner: "o", gitRepo: "r", gitUrl: bad as string }),
      );
      expect(group.source?.gitUrl).toBeNull();
    }
  });
});
