import type { OAuth2Tokens, OAuth2UserInfo } from "@better-auth/core/oauth2";
import type { GenericOAuthConfig } from "better-auth/plugins";
import type { AdvertisedAuthProvider } from "@repo/contracts";
import { diagnostics as errorDiagnostics, reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { decodeJwt } from "jose";
import { env } from "../config/env";

const SOCIAL_AUTH_PROVIDERS = ["github", "google"] as const;
type SocialAuthProviderId = (typeof SOCIAL_AUTH_PROVIDERS)[number];

export const DEFAULT_OIDC_DISPLAY_NAME = "SSO";
const AUTH_PROVIDERS_COMPONENT = "platform/engine/lib/auth-providers";

export type OidcProviderConfig = GenericOAuthConfig & {
  providerId: "oidc";
  displayName: string;
};

/**
 * Normalize OIDC profile claims for Better Auth user creation and account linking.
 * Trust `email_verified` only when the IdP explicitly sends boolean `true`.
 */
export function mapOidcProfileToUser(profile: Record<string, unknown>): {
  emailVerified: boolean;
  name?: string;
} {
  const emailVerified =
    "email_verified" in profile
      ? profile.email_verified === true
      : profile.emailVerified === true;
  const rawName = typeof profile.name === "string" ? profile.name.trim() : "";
  const preferredUsername =
    typeof profile.preferred_username === "string" ? profile.preferred_username.trim() : "";
  const nickname = typeof profile.nickname === "string" ? profile.nickname.trim() : "";
  const emailPrefix =
    typeof profile.email === "string" && profile.email.includes("@")
      ? (profile.email.split("@")[0]?.trim() ?? "")
      : "";
  const name = rawName || preferredUsername || nickname || emailPrefix;
  return {
    ...(name ? { name } : {}),
    emailVerified,
  };
}

/** Shared credential predicate for Better Auth registration and public discovery. */
export function socialProviderCredentials(
  id: SocialAuthProviderId,
): { clientId: string; clientSecret: string } | null {
  const pair = id === "github"
    ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
    : { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  if (!pair.clientId || !pair.clientSecret) return null;
  return { clientId: pair.clientId, clientSecret: pair.clientSecret };
}

const warnedPartialOidc = new Set<string>();

function warnPartialOidc(missing: string[]): void {
  const message =
    `[auth] OIDC login is partially configured (missing ${missing.join(", ")}); skipping oidc provider registration.`;
  if (warnedPartialOidc.has(message)) return;
  warnedPartialOidc.add(message);
  errorDiagnostics.warn(AUTH_PROVIDERS_COMPONENT, message);
}

function nonEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** User-table fields only. Raw claims such as `sub` or `groups` are not columns. */
function toOidcUser(profile: Record<string, unknown>): OAuth2UserInfo | null {
  const id = nonEmpty(profile.sub) || nonEmpty(profile.id);
  const email = nonEmpty(profile.email);
  if (!id || !email) return null;
  const mapped = mapOidcProfileToUser(profile);
  const image = nonEmpty(profile.picture) || nonEmpty(profile.image);
  return {
    id,
    email,
    emailVerified: mapped.emailVerified,
    ...(mapped.name ? { name: mapped.name } : {}),
    ...(image ? { image } : {}),
  };
}

function httpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

function userFromIdToken(idToken: string): OAuth2UserInfo | null {
  try {
    const claims = decodeJwt(idToken) as Record<string, unknown>;
    if (!nonEmpty(claims.sub) || !nonEmpty(claims.email)) return null;
    return toOidcUser(claims);
  } catch (error) {
    observeCaughtError(error, AUTH_PROVIDERS_COMPONENT);
    return null;
  }
}

async function readJson(url: URL, init?: RequestInit): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, init);
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch (error) {
    observeCaughtError(error, AUTH_PROVIDERS_COMPONENT);
    return null;
  }
}

/**
 * Prefer a usable id_token, then the discovery userinfo endpoint.
 * The generic-oauth callback spreads this object into the user insert, so it
 * must not carry claims outside the user schema.
 */
async function fetchOidcUserInfo(
  tokens: OAuth2Tokens,
  discoveryUrl: string,
): Promise<OAuth2UserInfo | null> {
  if (tokens.idToken) {
    const fromToken = userFromIdToken(tokens.idToken);
    if (fromToken) return fromToken;
  }
  if (!tokens.accessToken) return null;
  const discovery = httpUrl(discoveryUrl);
  if (!discovery) return null;
  const document = await readJson(discovery);
  const endpoint = document && typeof document.userinfo_endpoint === "string"
    ? document.userinfo_endpoint
    : "";
  const userInfoUrl = endpoint ? httpUrl(endpoint) : null;
  if (!userInfoUrl) return null;
  const profile = await readJson(userInfoUrl, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  return profile ? toOidcUser(profile) : null;
}

/** Register generic OIDC only when issuer, client id, and secret are all set. */
export function oidcProviderConfig(): OidcProviderConfig | undefined {
  const issuer = env.OIDC_ISSUER?.trim() ?? "";
  const clientId = env.OIDC_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.OIDC_CLIENT_SECRET?.trim() ?? "";
  if (!issuer && !clientId && !clientSecret) return undefined;
  if (!issuer || !clientId || !clientSecret) {
    const missing: string[] = [];
    if (!issuer) missing.push("OIDC_ISSUER");
    if (!clientId) missing.push("OIDC_CLIENT_ID");
    if (!clientSecret) missing.push("OIDC_CLIENT_SECRET");
    warnPartialOidc(missing);
    return undefined;
  }
  const discoveryUrl = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  return {
    providerId: "oidc",
    discoveryUrl,
    clientId,
    clientSecret,
    scopes: ["openid", "email", "profile"],
    pkce: true,
    displayName: env.OIDC_DISPLAY_NAME?.trim() || DEFAULT_OIDC_DISPLAY_NAME,
    mapProfileToUser: mapOidcProfileToUser,
    getUserInfo: (tokens) => fetchOidcUserInfo(tokens, discoveryUrl),
  };
}

/** Public response: IDs and kinds only; never return the registration credentials. */
export function configuredAuthProviders(): AdvertisedAuthProvider[] {
  const providers: AdvertisedAuthProvider[] = SOCIAL_AUTH_PROVIDERS
    .filter(id => socialProviderCredentials(id) !== null)
    .map(id => ({ id, kind: "social" }));
  const oidc = oidcProviderConfig();
  if (oidc) providers.push({ id: "oidc", kind: "oidc", name: oidc.displayName });
  return providers;
}
