import { validateAuthorizationCode, type OAuth2Tokens, type OAuth2UserInfo } from "@better-auth/core/oauth2";
import type { GenericOAuthConfig } from "better-auth/plugins";
import type { AdvertisedAuthProvider } from "@repo/contracts";
import { diagnostics as errorDiagnostics, reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";
import { env } from "../config/env";
import { oidcEndpointAllowed } from "./oidc-endpoint";

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

/**
 * OIDC Discovery 4 compares the configured issuer to `discovery.issuer` as
 * the same string, except one trailing slash is not significant. No other
 * normalization (case, scheme, host, path) is applied. Repeated trailing
 * slashes are stripped the same way the discovery URL is built.
 */
function normalizeIssuer(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

const ASYMMETRIC_ID_TOKEN_ALGS = [
  "RS256", "RS384", "RS512",
  "PS256", "PS384", "PS512",
  "ES256", "ES384", "ES512",
  "EdDSA",
] as const;

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;

type OidcDiscoveryDocument = {
  /** Exact `issuer` string from discovery. The ID token `iss` must match it. */
  issuer: string;
  authorizationEndpoint: string;
  jwksUri: string;
  tokenEndpoint: string;
  userinfoEndpoint: string | null;
  algorithms: string[];
};

const OIDC_DISCOVERY_TTL_MS = 60 * 60 * 1000;
const discoveryByIssuer = new Map<string, { document: OidcDiscoveryDocument; expiresAt: number }>();
const jwksByUri = new Map<string, RemoteJwks>();

/** Drop process caches. Tests use this so one case cannot pin another's document. */
export function clearOidcProviderCache(): void {
  discoveryByIssuer.clear();
  jwksByUri.clear();
}

function signingAlgorithms(document: Record<string, unknown>): string[] {
  const advertised = document.id_token_signing_alg_values_supported;
  const source = Array.isArray(advertised) ? advertised : ASYMMETRIC_ID_TOKEN_ALGS;
  return source.filter((alg): alg is string =>
    typeof alg === "string" &&
    alg !== "none" &&
    !alg.startsWith("HS") &&
    (ASYMMETRIC_ID_TOKEN_ALGS as readonly string[]).includes(alg),
  );
}

function allowedEndpoint(value: string): string | null {
  const trimmed = value.trim();
  const parsed = httpUrl(trimmed);
  if (!parsed || !oidcEndpointAllowed(parsed, env.NODE_ENV)) return null;
  return trimmed;
}

/** Accepted discovery expires after one hour. Rejected refreshes fail closed. */
export async function loadOidcDiscovery(): Promise<OidcDiscoveryDocument | null> {
  const configured = normalizeIssuer(env.OIDC_ISSUER ?? "");
  if (!configured) return null;
  const issuerUrl = httpUrl(configured);
  const discoveryUrlValue = `${configured}/.well-known/openid-configuration`;
  if (!issuerUrl || !oidcEndpointAllowed(issuerUrl, env.NODE_ENV)) return null;
  if (!allowedEndpoint(discoveryUrlValue)) return null;
  const cached = discoveryByIssuer.get(configured);
  if (cached && Date.now() < cached.expiresAt && cachedEndpointsAllowed(cached.document)) {
    return cached.document;
  }
  discoveryByIssuer.delete(configured);

  const document = await readJson(new URL(discoveryUrlValue));
  if (!document) return null;

  const discoveredIssuer = typeof document.issuer === "string" ? document.issuer.trim() : "";
  if (!discoveredIssuer || normalizeIssuer(discoveredIssuer) !== configured) return null;
  if (!allowedEndpoint(discoveredIssuer)) return null;

  const jwksUri = typeof document.jwks_uri === "string" ? allowedEndpoint(document.jwks_uri) : null;
  const tokenEndpoint = typeof document.token_endpoint === "string"
    ? allowedEndpoint(document.token_endpoint)
    : null;
  const authorizationEndpoint = typeof document.authorization_endpoint === "string"
    ? allowedEndpoint(document.authorization_endpoint)
    : null;
  if (!jwksUri || !tokenEndpoint || !authorizationEndpoint) return null;

  let userinfoEndpoint: string | null = null;
  if (typeof document.userinfo_endpoint === "string" && document.userinfo_endpoint.trim()) {
    userinfoEndpoint = allowedEndpoint(document.userinfo_endpoint);
    if (!userinfoEndpoint) return null;
  }

  const algorithms = signingAlgorithms(document);
  if (algorithms.length === 0) return null;

  const validated: OidcDiscoveryDocument = {
    issuer: discoveredIssuer,
    authorizationEndpoint,
    jwksUri,
    tokenEndpoint,
    userinfoEndpoint,
    algorithms,
  };
  discoveryByIssuer.set(configured, {
    document: validated,
    expiresAt: Date.now() + OIDC_DISCOVERY_TTL_MS,
  });
  return validated;
}

function cachedEndpointsAllowed(document: OidcDiscoveryDocument): boolean {
  return Boolean(
    allowedEndpoint(document.issuer) &&
    allowedEndpoint(document.authorizationEndpoint) &&
    allowedEndpoint(document.jwksUri) &&
    allowedEndpoint(document.tokenEndpoint) &&
    (document.userinfoEndpoint === null || allowedEndpoint(document.userinfoEndpoint)),
  );
}

function jwksFor(jwksUri: string): RemoteJwks {
  let jwks = jwksByUri.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksByUri.set(jwksUri, jwks);
  }
  return jwks;
}

function subject(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Nonce (OIDC Core 3.1.3.7 step 11, and the nonce parameter in 3.1.2.1).
 *
 * Better Auth 1.5 generic OAuth does not send or store a nonce.
 * `@better-auth/core` `createAuthorizationURL` has no nonce argument.
 * `POST /sign-in/oauth2` calls it with state, PKCE, scopes, and redirect only.
 * The OAuth state record stores callbackURL, codeVerifier, errorURL,
 * newUserURL, link, expiresAt, and requestSignUp (plus optional request
 * `additionalData`). It does not store a nonce. `getUserInfo` is called with
 * `OAuth2Tokens` only, so a nonce generated at sign-in cannot be compared here.
 * `authorizationUrlParams` could add a query parameter, but nothing would
 * round-trip the expected value into this callback. This code does not invent
 * that storage.
 *
 * PKCE (`pkce: true`) plus the state cookie binds the authorization code to
 * this browser session. Step 11 requires the nonce claim to be checked only
 * when the client sent a nonce in the authentication request. This client does
 * not send one, so an ID token that happens to carry a `nonce` claim is not
 * rejected for that claim.
 */
function authorizedPartyAccepts(payload: JWTPayload, clientId: string): boolean {
  const azp = (payload as { azp?: unknown }).azp;
  if (azp !== undefined && azp !== clientId) return false;
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && azp !== clientId) return false;
  return true;
}

async function verifyOidcIdToken(
  idToken: string,
  discovery: OidcDiscoveryDocument,
  clientId: string,
): Promise<JWTPayload | null> {
  let headerAlg: string | undefined;
  try {
    headerAlg = decodeProtectedHeader(idToken).alg;
  } catch (error) {
    observeCaughtError(error, AUTH_PROVIDERS_COMPONENT);
    return null;
  }
  if (!headerAlg || !discovery.algorithms.includes(headerAlg)) return null;

  try {
    const { payload } = await jwtVerify(idToken, jwksFor(discovery.jwksUri), {
      issuer: discovery.issuer,
      audience: clientId,
      algorithms: discovery.algorithms,
      clockTolerance: 60,
      requiredClaims: ["exp", "iat", "sub"],
    });
    if (!authorizedPartyAccepts(payload, clientId)) return null;
    if (typeof payload.iat !== "number" || !subject(payload.sub)) return null;
    return payload;
  } catch (error) {
    observeCaughtError(error, AUTH_PROVIDERS_COMPONENT);
    return null;
  }
}

/**
 * Identity comes from the verified ID token. `email_verified` is taken only
 * from that token (boolean true). Userinfo may add profile fields after its
 * `sub` matches (OIDC Core 5.3.2). A mismatch rejects the login entirely.
 */
function profileFromVerifiedToken(
  claims: JWTPayload,
  userinfo: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const token = claims as Record<string, unknown>;
  if (userinfo && subject(userinfo.sub) !== subject(token.sub)) return null;
  const email = nonEmpty(token.email) || (userinfo ? nonEmpty(userinfo.email) : "");
  if (!subject(token.sub) || !email) return null;
  return {
    ...(userinfo ?? {}),
    ...token,
    sub: token.sub,
    email,
    email_verified: token.email_verified === true,
  };
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
 * Require a verified ID token. This provider always requests the `openid`
 * scope, and OIDC Core 3.1.3.3 returns an id_token on the code flow. Userinfo
 * is not a fallback identity: a missing or invalid id_token returns null.
 * When userinfo is also returned, its `sub` must match the token (5.3.2).
 * The generic-oauth callback spreads this object into the user insert, so it
 * must not carry claims outside the user schema.
 */
async function fetchOidcUserInfo(
  tokens: OAuth2Tokens,
  clientId: string,
): Promise<OAuth2UserInfo | null> {
  const discovery = await loadOidcDiscovery();
  if (!discovery || !tokens.idToken) return null;
  const claims = await verifyOidcIdToken(tokens.idToken, discovery, clientId);
  if (!claims) return null;

  let userinfo: Record<string, unknown> | null = null;
  if (tokens.accessToken && discovery.userinfoEndpoint) {
    const userinfoUrl = httpUrl(discovery.userinfoEndpoint);
    if (!userinfoUrl) return null;
    userinfo = await readJson(userinfoUrl, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (userinfo && subject(userinfo.sub) !== subject(claims.sub)) return null;
  }

  const profile = profileFromVerifiedToken(claims, userinfo);
  return profile ? toOidcUser(profile) : null;
}

async function exchangeOidcAuthorizationCode(
  data: { code: string; redirectURI: string; codeVerifier?: string },
  clientId: string,
  clientSecret: string,
): Promise<OAuth2Tokens> {
  const discovery = await loadOidcDiscovery();
  if (!discovery) {
    errorDiagnostics.warn(
      AUTH_PROVIDERS_COMPONENT,
      "[auth] OIDC discovery rejected; refusing the token exchange.",
    );
    throw new Error("OIDC discovery rejected");
  }
  return validateAuthorizationCode({
    code: data.code,
    codeVerifier: data.codeVerifier,
    redirectURI: data.redirectURI,
    options: { clientId, clientSecret },
    tokenEndpoint: discovery.tokenEndpoint,
  });
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
    getToken: (data) => exchangeOidcAuthorizationCode(data, clientId, clientSecret),
    getUserInfo: (tokens) => fetchOidcUserInfo(tokens, clientId),
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
