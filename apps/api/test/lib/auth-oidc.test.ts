import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";

const ISSUER = "https://idp.example.test/application/o/openship/";
const CLIENT_ID = "oidc-test-client-id";

const oidcEnv = vi.hoisted(() => {
  const keys = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_DISPLAY_NAME"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<
    (typeof keys)[number],
    string | undefined
  >;
  Object.assign(process.env, {
    OIDC_ISSUER: "https://idp.example.test/application/o/openship/",
    OIDC_CLIENT_ID: "oidc-test-client-id",
    OIDC_CLIENT_SECRET: "oidc-test-client-secret",
    OIDC_DISPLAY_NAME: "Authentik",
  });
  return { previous };
});

import { closeDb, db, eq, schema } from "@repo/db";
import { env } from "@repo/platform/engine/config/env";
import { auth } from "@repo/platform/engine/lib/auth";
import { clearAuthModeCache } from "@repo/platform/engine/lib/auth-mode";
import { clearOidcProviderCache } from "@repo/platform/engine/lib/auth-providers";
import { provisionUser } from "@repo/platform/engine/lib/provision-user";

afterAll(() => {
  for (const [key, value] of Object.entries(oidcEnv.previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return closeDb();
});

const AUTHORIZATION_ENDPOINT = "https://idp.example.test/application/o/authorize/";
const TOKEN_ENDPOINT = "https://idp.example.test/application/o/token/";
const USERINFO_ENDPOINT = "https://idp.example.test/application/o/userinfo/";
const JWKS_URL = "https://idp.example.test/application/o/jwks";

let idpUserInfo: Record<string, unknown> = {};
let discoveryIssuer: string | null = null;
let authorizationEndpoint: string | null = AUTHORIZATION_ENDPOINT;
let subsequentAuthorizationEndpoint: string | null = null;
let discoveryRequests = 0;
let currentIdToken: string | null = null;
let omitIdToken = false;
let signingKey: CryptoKey;
let otherSigningKey: CryptoKey;
let publicJwk: JWK;
let signingKid = "";
const initialNodeEnv = env.NODE_ENV;
const initialIssuer = env.OIDC_ISSUER;

function idpProfile(profile: Record<string, unknown>): Record<string, unknown> {
  return {
    groups: ["engineering"],
    picture: "https://idp.example.test/avatar.png",
    ...profile,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  signingKey = keys.privateKey;
  const jwk = await exportJWK(keys.publicKey);
  signingKid = await calculateJwkThumbprint(jwk);
  jwk.kid = signingKid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  publicJwk = jwk;
  otherSigningKey = (await generateKeyPair("RS256", { extractable: true })).privateKey;
});

beforeEach(async () => {
  env.NODE_ENV = initialNodeEnv;
  env.OIDC_ISSUER = initialIssuer;
  discoveryIssuer = null;
  authorizationEndpoint = AUTHORIZATION_ENDPOINT;
  subsequentAuthorizationEndpoint = null;
  discoveryRequests = 0;
  currentIdToken = null;
  omitIdToken = false;
  clearOidcProviderCache();

  await db.delete(schema.invitation);
  await db.delete(schema.session);
  await db.delete(schema.account);
  await db.delete(schema.member);
  await db.delete(schema.organization);
  await db.delete(schema.user);
  await db.delete(schema.instanceSettings);
  clearAuthModeCache();

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/.well-known/openid-configuration")) {
      return jsonResponse({
        issuer: discoveryIssuer ?? ISSUER,
        authorization_endpoint: ++discoveryRequests > 1
          ? subsequentAuthorizationEndpoint ?? authorizationEndpoint
          : authorizationEndpoint,
        token_endpoint: TOKEN_ENDPOINT,
        userinfo_endpoint: USERINFO_ENDPOINT,
        jwks_uri: JWKS_URL,
        id_token_signing_alg_values_supported: ["RS256", "none", "HS256"],
      });
    }
    if (url === JWKS_URL) return jsonResponse({ keys: [publicJwk] });
    if (url === TOKEN_ENDPOINT) {
      const body: Record<string, unknown> = {
        access_token: "oidc-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email profile",
      };
      if (!omitIdToken && currentIdToken) body.id_token = currentIdToken;
      return jsonResponse(body);
    }
    if (url === USERINFO_ENDPOINT) return jsonResponse(idpUserInfo);
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  env.NODE_ENV = initialNodeEnv;
  env.OIDC_ISSUER = initialIssuer;
  globalThis.fetch = originalFetch;
  clearAuthModeCache();
  clearOidcProviderCache();
});

async function signIdToken(input: {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  iss?: string;
  aud?: string | string[];
  azp?: string;
  exp?: number;
  iat?: number;
  nonce?: string;
  key?: CryptoKey;
  kid?: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {};
  if (input.email !== undefined) payload.email = input.email;
  if (input.email_verified !== undefined) payload.email_verified = input.email_verified;
  if (input.name !== undefined) payload.name = input.name;
  if (input.azp !== undefined) payload.azp = input.azp;
  if (input.nonce !== undefined) payload.nonce = input.nonce;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: input.kid ?? signingKid })
    .setIssuer(input.iss ?? discoveryIssuer ?? ISSUER)
    .setSubject(input.sub)
    .setAudience(input.aud ?? CLIENT_ID)
    .setIssuedAt(input.iat ?? now)
    .setExpirationTime(input.exp ?? now + 600)
    .sign(input.key ?? signingKey);
}

function unsignedIdToken(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

async function presentIdp(
  profile: Record<string, unknown>,
  overrides: Partial<Parameters<typeof signIdToken>[0]> = {},
): Promise<void> {
  idpUserInfo = idpProfile(profile);
  currentIdToken = await signIdToken({
    sub: String(profile.sub),
    email: String(profile.email),
    email_verified: profile.email_verified === true,
    ...(typeof profile.name === "string" ? { name: profile.name } : {}),
    ...overrides,
  });
}

async function seedUser(id: string, email: string): Promise<void> {
  await provisionUser({
    id,
    name: "Existing User",
    email,
    emailVerified: false,
    role: "admin",
  });
}

async function startOidcSignIn(): Promise<{
  state: string;
  cookieHeader: string;
  authorizationUrl: URL;
}> {
  const response = await auth.handler(
    new Request("http://localhost:4000/api/auth/sign-in/oauth2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "oidc",
        callbackURL: "http://localhost:3001/projects",
      }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { url: string; redirect: boolean };
  const authorizationUrl = new URL(body.url);
  const state = authorizationUrl.searchParams.get("state");
  expect(state).toBeTruthy();
  expect(authorizationUrl.searchParams.get("nonce")).toBeNull();

  const setCookies = response.headers.getSetCookie?.() ?? [
    response.headers.get("set-cookie") ?? "",
  ];
  const cookieHeader = setCookies
    .map((cookie) => cookie.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");

  return { state: state!, cookieHeader, authorizationUrl };
}

async function completeOidcCallback(state: string, cookieHeader: string): Promise<Response> {
  const callbackUrl = new URL("http://localhost:4000/api/auth/oauth2/callback/oidc");
  callbackUrl.searchParams.set("code", "oidc-auth-code");
  callbackUrl.searchParams.set("state", state);

  return auth.handler(
    new Request(callbackUrl.toString(), {
      method: "GET",
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
    }),
  );
}

/** A token that would link `email` if it were trusted. Rejection must not. */
async function expectLoginRejected(
  email: string,
  userId: string,
  beforeCallback?: () => void,
): Promise<void> {
  const { state, cookieHeader } = await startOidcSignIn();
  beforeCallback?.();
  const callbackRes = await completeOidcCallback(state, cookieHeader);
  expect(callbackRes.status).toBe(302);
  const location = new URL(callbackRes.headers.get("location")!);
  expect(location.searchParams.get("error")).toBeTruthy();
  expect(location.href).not.toBe("http://localhost:3001/projects");

  const users = await db.select().from(schema.user).where(eq(schema.user.email, email));
  expect(users).toHaveLength(1);
  expect(users[0]!.id).toBe(userId);
  expect(users[0]!.emailVerified).toBe(false);
  const accounts = await db
    .select()
    .from(schema.account)
    .where(eq(schema.account.userId, userId));
  expect(accounts).toHaveLength(0);
  expect(await db.select().from(schema.session)).toHaveLength(0);
}

describe("OIDC generic-oauth integration", () => {
  it("does not link to an existing user and does not mark email verified when email_verified is false", async () => {
    await seedUser("user_existing_1", "existing@example.test");
    await presentIdp({
      sub: "oidc-sub-unverified",
      email: "existing@example.test",
      email_verified: false,
      name: "Existing User",
    });

    const { state, cookieHeader, authorizationUrl } = await startOidcSignIn();
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(AUTHORIZATION_ENDPOINT);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "http://localhost:4000/api/auth/oauth2/callback/oidc",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe("openid email profile");

    const callbackRes = await completeOidcCallback(state, cookieHeader);
    expect(callbackRes.status).toBe(302);
    const redirectLocation = new URL(callbackRes.headers.get("location")!);
    expect(redirectLocation.searchParams.get("error")).toBe("account_not_linked");

    const users = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, "existing@example.test"));
    expect(users).toHaveLength(1);
    expect(users[0]!.id).toBe("user_existing_1");
    expect(users[0]!.emailVerified).toBe(false);

    const accounts = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, "user_existing_1"));
    expect(accounts).toHaveLength(0);
  });

  it("links to an existing user and marks email verified when email_verified is true", async () => {
    await seedUser("user_existing_2", "verified@example.test");
    await presentIdp({
      sub: "oidc-sub-verified",
      email: "verified@example.test",
      email_verified: true,
      name: "Existing User",
    });

    const { state, cookieHeader } = await startOidcSignIn();
    const callbackRes = await completeOidcCallback(state, cookieHeader);
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("location")).toBe("http://localhost:3001/projects");

    const users = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, "verified@example.test"));
    expect(users).toHaveLength(1);
    expect(users[0]!.id).toBe("user_existing_2");
    expect(users[0]!.emailVerified).toBe(true);

    const accounts = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, "user_existing_2"));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.providerId).toBe("oidc");
    expect(accounts[0]!.accountId).toBe("oidc-sub-verified");
  });

  it("accepts an id_token nonce this client never sent", async () => {
    await seedUser("user_nonce", "nonce@example.test");
    await presentIdp(
      {
        sub: "oidc-sub-nonce",
        email: "nonce@example.test",
        email_verified: true,
        name: "Nonce User",
      },
      { nonce: "idp-supplied-nonce" },
    );

    const { state, cookieHeader } = await startOidcSignIn();
    const callbackRes = await completeOidcCallback(state, cookieHeader);
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("location")).toBe("http://localhost:3001/projects");
    const accounts = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, "user_nonce"));
    expect(accounts).toHaveLength(1);
  });

  it("enforces the invite-only gate on oidc sign-ups and leaves unverified invited sign-ups unverified", async () => {
    await provisionUser({
      id: "admin_1",
      name: "Instance Admin",
      email: "admin@example.test",
      emailVerified: true,
      role: "admin",
    });

    await presentIdp({
      sub: "oidc-sub-stranger",
      email: "stranger@example.test",
      email_verified: true,
      name: "Stranger",
    });
    const uninvitedStart = await startOidcSignIn();
    const uninvitedRes = await completeOidcCallback(
      uninvitedStart.state,
      uninvitedStart.cookieHeader,
    );
    expect(uninvitedRes.status).toBe(302);
    const uninvitedLocation = new URL(uninvitedRes.headers.get("location")!);
    expect(uninvitedLocation.searchParams.get("error")).toContain("invite-only");

    const strangerRows = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, "stranger@example.test"));
    expect(strangerRows).toHaveLength(0);

    await db.insert(schema.invitation).values({
      id: "inv_oidc_1",
      organizationId: "org_admin_1",
      email: "invited@example.test",
      role: "member",
      status: "pending",
      inviterId: "admin_1",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await presentIdp({
      sub: "oidc-sub-invited",
      email: "invited@example.test",
      email_verified: false,
      name: "Invited Member",
    });
    const invitedStart = await startOidcSignIn();
    const invitedRes = await completeOidcCallback(
      invitedStart.state,
      invitedStart.cookieHeader,
    );
    expect(invitedRes.status).toBe(302);
    expect(invitedRes.headers.get("location")).toBe("http://localhost:3001/projects");

    const invitedRows = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, "invited@example.test"));
    expect(invitedRows).toHaveLength(1);
    expect(invitedRows[0]!.emailVerified).toBe(false);
    expect(invitedRows[0]!.image).toBe("https://idp.example.test/avatar.png");
  });

  it("keeps the oidc provider inert when the instance is in zero-auth mode", async () => {
    await db.insert(schema.instanceSettings).values({
      id: "default",
      authMode: "none",
    });
    clearAuthModeCache();

    const response = await auth.handler(
      new Request("http://localhost:4000/api/auth/sign-in/oauth2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "oidc",
          callbackURL: "http://localhost:3001/projects",
        }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects an unsigned id_token through the callback", async () => {
    const email = "unsigned@example.test";
    await seedUser("user_unsigned", email);
    const now = Math.floor(Date.now() / 1000);
    idpUserInfo = idpProfile({
      sub: "oidc-sub-unsigned",
      email,
      email_verified: true,
      name: "Unsigned",
    });
    currentIdToken = unsignedIdToken({
      sub: "oidc-sub-unsigned",
      email,
      email_verified: true,
      iss: ISSUER,
      aud: CLIENT_ID,
      iat: now,
      exp: now + 600,
    });
    await expectLoginRejected(email, "user_unsigned");
  });

  it("rejects an id_token signed by a different key through the callback", async () => {
    const email = "bad-signature@example.test";
    await seedUser("user_bad_sig", email);
    await presentIdp(
      {
        sub: "oidc-sub-bad-sig",
        email,
        email_verified: true,
        name: "Bad Signature",
      },
      { key: otherSigningKey, kid: signingKid },
    );
    await expectLoginRejected(email, "user_bad_sig");
  });

  it("rejects an expired id_token through the callback", async () => {
    const email = "expired@example.test";
    await seedUser("user_expired", email);
    const now = Math.floor(Date.now() / 1000);
    await presentIdp(
      { sub: "oidc-sub-expired", email, email_verified: true, name: "Expired" },
      { iat: now - 3600, exp: now - 120 },
    );
    await expectLoginRejected(email, "user_expired");
  });

  it("rejects an id_token from the wrong issuer through the callback", async () => {
    const email = "wrong-issuer@example.test";
    await seedUser("user_wrong_iss", email);
    await presentIdp(
      { sub: "oidc-sub-wrong-iss", email, email_verified: true, name: "Wrong Issuer" },
      { iss: "https://evil.example.test" },
    );
    await expectLoginRejected(email, "user_wrong_iss");
  });

  it("rejects an id_token with the wrong audience through the callback", async () => {
    const email = "wrong-audience@example.test";
    await seedUser("user_wrong_aud", email);
    await presentIdp(
      { sub: "oidc-sub-wrong-aud", email, email_verified: true, name: "Wrong Audience" },
      { aud: "some-other-client" },
    );
    await expectLoginRejected(email, "user_wrong_aud");
  });

  it("rejects a userinfo subject that does not match the id_token through the callback", async () => {
    const email = "mismatch-sub@example.test";
    await seedUser("user_mismatch_sub", email);
    await presentIdp({
      sub: "oidc-sub-token",
      email,
      email_verified: true,
      name: "Mismatch",
    });
    idpUserInfo = idpProfile({
      sub: "oidc-sub-userinfo",
      email,
      email_verified: true,
      name: "Mismatch",
    });
    await expectLoginRejected(email, "user_mismatch_sub");
  });

  it("rejects an id_token whose azp is not the client id through the callback", async () => {
    const email = "azp-mismatch@example.test";
    await seedUser("user_azp", email);
    await presentIdp(
      { sub: "oidc-sub-azp", email, email_verified: true, name: "Azp" },
      { aud: [CLIENT_ID, "other-app"], azp: "other-app" },
    );
    await expectLoginRejected(email, "user_azp");
  });

  it("rejects a multi-audience id_token that omits azp through the callback", async () => {
    const email = "azp-missing@example.test";
    await seedUser("user_azp_missing", email);
    await presentIdp(
      { sub: "oidc-sub-azp-missing", email, email_verified: true, name: "Azp Missing" },
      { aud: [CLIENT_ID, "other-app"] },
    );
    await expectLoginRejected(email, "user_azp_missing");
  });

  it("rejects discovery whose issuer does not match OIDC_ISSUER through the callback", async () => {
    const email = "discovery-mismatch@example.test";
    await seedUser("user_discovery", email);
    await presentIdp(
      {
        sub: "oidc-sub-discovery",
        email,
        email_verified: true,
        name: "Discovery",
      },
      { iss: "https://evil.example.test" },
    );
    await expectLoginRejected(email, "user_discovery", () => {
      discoveryIssuer = "https://evil.example.test";
      clearOidcProviderCache();
    });
  });

  it("rejects an http issuer in production through the callback", async () => {
    const email = "http-issuer@example.test";
    await seedUser("user_http", email);
    const httpIssuer = "http://idp.example.test/application/o/openship/";
    await presentIdp(
      {
        sub: "oidc-sub-http",
        email,
        email_verified: true,
        name: "Http Issuer",
      },
      { iss: httpIssuer },
    );
    await expectLoginRejected(email, "user_http", () => {
      env.NODE_ENV = "production";
      env.OIDC_ISSUER = httpIssuer;
      discoveryIssuer = httpIssuer;
      clearOidcProviderCache();
    });
  });

  it.each([
    ["http authorization endpoint in production", "http://idp.example.test/authorize", ISSUER],
    ["missing authorization endpoint", null, ISSUER],
    ["issuer mismatch", AUTHORIZATION_ENDPOINT, "https://evil.example.test"],
    ["http issuer in production", AUTHORIZATION_ENDPOINT, "http://idp.example.test"],
  ])("refuses sign-in for %s", async (_name, endpoint, issuer) => {
    env.NODE_ENV = "production";
    authorizationEndpoint = endpoint;
    discoveryIssuer = issuer;
    if (issuer.startsWith("http:")) env.OIDC_ISSUER = issuer;
    const response = await auth.handler(new Request("http://localhost:4000/api/auth/sign-in/oauth2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "oidc" }),
    }));
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toMatchObject({ code: "OIDC_DISCOVERY_REJECTED" });
  });

  it("returns the validated authorization endpoint for valid discovery", async () => {
    const { authorizationUrl } = await startOidcSignIn();
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(AUTHORIZATION_ENDPOINT);
    expect(authorizationUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
  });

  it.each([
    "http://evil.example.test/authorize",
    "https://idp.example.test/other-authorize/",
  ])("refuses a changed authorize URL from the second discovery fetch: %s", async (endpoint) => {
    subsequentAuthorizationEndpoint = endpoint;
    const response = await auth.handler(new Request("http://localhost:4000/api/auth/sign-in/oauth2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "oidc" }),
    }));
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    const body = await response.json();
    expect(body).toMatchObject({ code: "OIDC_AUTHORIZATION_ENDPOINT_MISMATCH" });
    expect(body).not.toHaveProperty("url");
  });

  it("does not accept userinfo as an identity when the token response has no id_token", async () => {
    const email = "userinfo-only@example.test";
    await seedUser("user_userinfo_only", email);
    omitIdToken = true;
    idpUserInfo = idpProfile({
      sub: "oidc-sub-userinfo-only",
      email,
      email_verified: true,
      name: "Userinfo Only",
    });
    await expectLoginRejected(email, "user_userinfo_only");
  });
});
