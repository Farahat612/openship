/**
 * Project source model — the discriminator for WHERE a project's code/dist
 * comes from. Shared by the db schema, API request validation, and deploy
 * dispatch so the allowed set can't drift across layers (a typo in one place
 * silently bypassing the release path is exactly the bug we're avoiding).
 */

/**
 * Values stored in `project.gitProvider` / `project_app.gitProvider`.
 *
 * This is THE canonical set. The columns are typed `.$type<SourceProvider>()`
 * (packages/db/src/schema/project.ts) and the API body validator derives its
 * literals from this array (`SourceProviderEnum`), so an unlisted provider
 * string is a compile error at every write site and a 400 at the HTTP edge.
 * Adding a provider = adding it here, once.
 *
 * NOTE: the SQL column is still plain `text` — this is a compile-time union,
 * not a DB constraint. Rows written before the union existed are read back as
 * `SourceProvider` on faith, so anything reading a value that did NOT come
 * from a checked write (a manifest file, a request body) must narrow it with
 * `asSourceProvider` rather than cast.
 */
export const SOURCE_PROVIDERS = [
  "github",
  "gitlab",
  "bitbucket",
  "local",
  "upload",
  "release",
] as const;
export type SourceProvider = (typeof SOURCE_PROVIDERS)[number];

/** Provider assumed when a caller omits one (matches the column default). */
export const DEFAULT_SOURCE_PROVIDER: SourceProvider = "github";

/** Type guard for an unvalidated value off the wire / off disk. */
export function isSourceProvider(value: unknown): value is SourceProvider {
  return typeof value === "string" && (SOURCE_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Narrow an unvalidated provider string to the union, or `null` if it isn't one.
 * Use at the boundaries the type system can't reach (the on-server openship
 * manifest, any hand-edited JSON) so a junk value can never reach a project row.
 */
export function asSourceProvider(value: unknown): SourceProvider | null {
  return isSourceProvider(value) ? value : null;
}

/**
 * True for a release/dist source (no repo, no build — deploy a prebuilt
 * distribution). Takes the union, not `string`: reading a provider that hasn't
 * been narrowed is the bug this exists to prevent.
 */
export function isReleaseProvider(gitProvider: SourceProvider | null | undefined): boolean {
  return gitProvider === "release";
}

// ─── The project's remote ────────────────────────────────────────────────────
//
// `project.gitUrl` / `project_app.gitUrl` is THE stored remote. It used to be a
// derived value nobody read — every consumer rebuilt `https://github.com/…`
// from owner/repo — which made "any remote that isn't github.com" a code change
// at every clone site instead of a data change. These three helpers are the
// seam: `githubCloneUrl` BUILDS (github only), `resolveSourceRemote` READS
// (stored first), `asRemoteGitUrl` VALIDATES an untrusted one.

/**
 * Is this source hosted on GitHub? THE one reading of the provider column, so
 * every GitHub-specific behavior answers it identically.
 *
 * `null`/absent counts as github: the column defaults to "github" and rows
 * written before it existed read back null, and those rows ARE GitHub projects.
 * Anything else — including a provider string that is checked but not github —
 * is not, which is the whole point of reading the column instead of inferring
 * from "there is a gitOwner".
 */
export function isGithubProvider(gitProvider: SourceProvider | null | undefined): boolean {
  return gitProvider == null || gitProvider === "github";
}

/**
 * Build the GitHub HTTPS clone URL for an owner/repo pair.
 *
 * GitHub-only by construction — this is the shape github.com serves, not a
 * generic template. It stays the value written at every GitHub link/create
 * site, and the FALLBACK for rows stored before `gitUrl` was read back
 * (`resolveSourceRemote`). A second provider gets its own builder (or, better,
 * persists the remote it was given) rather than a `provider` parameter here.
 */
export function githubCloneUrl(
  owner?: string | null,
  repo?: string | null,
): string | undefined {
  return owner && repo ? `https://github.com/${owner}/${repo}.git` : undefined;
}

/**
 * The remote to clone/fetch this source from: the STORED `gitUrl` when there is
 * one, else the GitHub builder for a GitHub project.
 *
 * The fallback is provider-GATED on purpose. A project whose provider is no
 * longer "github" (a `localPath` ensure sets `gitProvider="local"` and NULLs
 * `gitUrl` while leaving the old `gitOwner`/`gitRepo` in place) must not have a
 * github.com remote conjured back out of those stale columns — it would hand
 * the deploy pipeline a repo URL for a project that deploys from a directory.
 */
export function resolveSourceRemote(source: {
  gitProvider?: SourceProvider | null;
  gitUrl?: string | null;
  gitOwner?: string | null;
  gitRepo?: string | null;
}): string | undefined {
  const stored = source.gitUrl?.trim();
  if (stored) return stored;
  return isGithubProvider(source.gitProvider)
    ? githubCloneUrl(source.gitOwner, source.gitRepo)
    : undefined;
}

/** Longest remote we'll accept off an untrusted source. Generous — real remotes
 *  are ~60 chars; this only stops a pathological blob reaching a text column. */
const MAX_REMOTE_URL_LENGTH = 512;

/**
 * Narrow an UNVALIDATED remote URL (the on-server `.openship/manifest.json`,
 * any hand-edited JSON) to one that is safe to persist as a project's remote —
 * or `null`, which sends the caller back to rebuilding it.
 *
 * The `asSourceProvider` of URLs, and needed for the same reason: a manifest is
 * remote JSON read off a box we do not control, and this value ends up in a
 * project row and from there in a `git clone` on a build host.
 *
 * Accepted: `https://host/path`, nothing else.
 *   - https ONLY — an `ssh://`/`git@` remote needs host keys nobody has vetted
 *     (see the known-hosts item in the provider-agnostic git plan), and a
 *     `file://`/`ext::` remote is local-file read or command execution on the
 *     build host.
 *   - NO embedded credentials — `https://user:token@host/…` would persist a
 *     secret into the DB and echo it into every clone command and build log.
 *   - A real hostname, and no leading `-` (git would read the URL as an option;
 *     `assembleGitClone` refuses those too, this just keeps them out of the DB).
 */
export function asRemoteGitUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REMOTE_URL_LENGTH) return null;
  if (trimmed.startsWith("-")) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  if (url.username || url.password) return null;
  return trimmed;
}

/**
 * A release/dist source. Either a GitHub-Releases asset (repo + assetTemplate)
 * or an external HTTPS tarball (distUrl + sha256/sha256Url). The deployed
 * VERSION (a semver tag), not a commit, drives redeploys.
 */
export interface ReleaseSource {
  mode: "github" | "url";
  /** GitHub "owner/repo" (mode="github"). */
  repo?: string;
  /**
   * Asset-name template (mode="github"). Placeholders: {tag} {version} {os} {arch}.
   * e.g. "openship-{tag}-{os}-{arch}.tar.gz".
   */
  assetTemplate?: string;
  /**
   * OS/arch used to fill the asset name — the DEPLOY TARGET's, which is why they are
   * config and not measured: the dist is downloaded onto the control plane and then
   * streamed to a server that may be a different architecture entirely, so the API
   * box's own arch is the one answer that is never right. Default "linux"/"amd64".
   */
  os?: string;
  arch?: string;
  /** External HTTPS tarball URL (mode="url"). May contain {version}. */
  distUrl?: string;
  /** External sha256 sidecar URL, OR a pinned inline hash for a fixed distUrl. */
  sha256Url?: string;
  sha256?: string;
  /** mode="url" drift source: a URL returning the latest semver (plain text or {version}). */
  versionUrl?: string;
  /** Reserved: release-tag prefix / channel filter. */
  channel?: string;
  /** Pin to a specific version instead of resolving "latest". */
  pinnedVersion?: string;
  /** Opt into release-webhook auto-deploy. */
  trackReleases?: boolean;
}

/**
 * The four placeholders this renderer knows. Anything else in a template is a typo,
 * and {@link renderAssetName} refuses rather than shipping it into a URL.
 */
const ASSET_PLACEHOLDERS = ["tag", "version", "os", "arch"] as const;

/**
 * Fill a GitHub asset-name template from a version + os/arch.
 *
 * `os`/`arch` default to the publisher convention (`linux`/`amd64`) because they name
 * an ASSET the release author chose to publish, not a host anyone measured — see the
 * note on `ReleaseSource.os`. Deriving them from the running process would be worse
 * than the default: the control plane downloads the dist and then streams it to a
 * server that may not share its architecture.
 *
 * An unknown placeholder throws. Left alone it survives into the download URL, GitHub
 * 404s, and the operator is told "release dist not found at <cache path>" — a message
 * about a cache directory when the fault is a typo in a template they can see.
 */
export function renderAssetName(
  template: string,
  opts: { version: string; os?: string; arch?: string },
): string {
  const version = opts.version.replace(/^v/, "");
  const tag = `v${version}`;
  const rendered = template
    .replaceAll("{tag}", tag)
    .replaceAll("{version}", version)
    .replaceAll("{os}", opts.os ?? "linux")
    .replaceAll("{arch}", opts.arch ?? "amd64");

  const stray = rendered.match(/\{[^{}]*\}/g);
  if (stray) {
    throw new Error(
      `Release asset template ${JSON.stringify(template)} uses unknown placeholder(s) ` +
        `${stray.join(", ")}. Supported: ${ASSET_PLACEHOLDERS.map((p) => `{${p}}`).join(" ")}.`,
    );
  }
  return rendered;
}
