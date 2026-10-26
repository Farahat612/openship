import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const oidcEnv = await vi.hoisted(async () => {
  const { createServer } = await import("node:http");
  let handle: (url: string, body: string) => Promise<Response> = async () =>
    new Response(null, { status: 503 });
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const result = await handle(
        `http://${request.headers.host}${request.url}`,
        Buffer.concat(chunks).toString(),
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("IdP fixture did not listen");
  const origin = `http://127.0.0.1:${address.port}`;
  const keys = [
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_DISPLAY_NAME",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<
    (typeof keys)[number],
    string | undefined
  >;
  Object.assign(process.env, {
    OIDC_ISSUER: `${origin}/application/o/openship/`,
    OIDC_CLIENT_ID: "oidc-test-client-id",
    OIDC_CLIENT_SECRET: "oidc-test-client-secret",
    OIDC_DISPLAY_NAME: "Authentik",
  });
  return {
    previous,
    origin,
    server,
    setHandler: (handler: typeof handle) => {
      handle = handler;
    },
  };
});

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { closeDb, db, eq, schema } from "@repo/db";
import { auth } from "@repo/platform/engine/lib/auth";
import { clearAuthModeCache } from "@repo/platform/engine/lib/auth-mode";
import { provisionUser } from "@repo/platform/engine/lib/provision-user";

afterAll(async () => {
  for (const [key, value] of Object.entries(oidcEnv.previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise<void>((resolve, reject) =>
    oidcEnv.server.close((error) => (error ? reject(error) : resolve())),
  );
  await closeDb();
});

const DISCOVERY_URL = `${oidcEnv.origin}/application/o/openship/.well-known/openid-configuration`;
const AUTHORIZATION_ENDPOINT = `${oidcEnv.origin}/application/o/authorize/`;
const TOKEN_ENDPOINT = `${oidcEnv.origin}/application/o/token/`;
const USERINFO_ENDPOINT = `${oidcEnv.origin}/application/o/userinfo/`;

const ISSUER = `${oidcEnv.origin}/application/o/openship/`;
const JWKS_ENDPOINT = `${oidcEnv.origin}/jwks`;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let wrongKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKey: Awaited<ReturnType<typeof exportJWK>>;
let nonce = "";
let tokenMode = "valid";
let discoveryOverride: Record<string, unknown> = {};
let idpUserInfo: Record<string, unknown> = {};
let tokenRequests = 0;
let userInfoRequests = 0;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  wrongKeys = await generateKeyPair("RS256");
  publicKey = { ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
});

async function idToken(): Promise<string | undefined> {
  if (tokenMode === "missing") return undefined;
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    ...idpUserInfo,
    iss: ISSUER,
    aud: "oidc-test-client-id",
    iat: now,
    exp: now + 300,
    nonce,
  };
  if (tokenMode === "wrong issuer") payload.iss = "https://other.example.test";
  if (tokenMode === "wrong audience") payload.aud = "other-client";
  if (tokenMode === "expired") payload.exp = now - 120;
  if (tokenMode === "future issuance") payload.iat = now + 120;
  if (tokenMode === "wrong nonce") payload.nonce = "other-sign-in";
  if (tokenMode === "missing nonce") delete payload.nonce;
  if (tokenMode === "missing expiry") delete payload.exp;
  if (tokenMode === "wrong authorized party") payload.azp = "other-client";
  if (tokenMode === "multiple audiences") payload.aud = ["oidc-test-client-id", "other-client"];
  if (tokenMode.startsWith("userinfo")) delete payload.email;
  if (tokenMode === "userinfo unverified token") payload.email_verified = false;
  if (tokenMode === "userinfo mismatch") payload.sub = "different-subject";
  if (tokenMode === "unsigned") {
    const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${enc({ alg: "none" })}.${enc(payload)}.`;
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .sign(tokenMode === "wrong signature" ? wrongKeys.privateKey : keys.privateKey);
}

function idpProfile(profile: Record<string, unknown>): Record<string, unknown> {
  return {
    groups: ["engineering"],
    picture: "https://idp.example.test/avatar.png",
    ...profile,
  };
}

beforeEach(async () => {
  tokenMode = "valid";
  discoveryOverride = {};
  tokenRequests = 0;
  userInfoRequests = 0;
  await db.delete(schema.verification);
  await db.delete(schema.invitation);
  await db.delete(schema.session);
  await db.delete(schema.account);
  await db.delete(schema.member);
  await db.delete(schema.organization);
  await db.delete(schema.user);
  await db.delete(schema.instanceSettings);
  clearAuthModeCache();

  oidcEnv.setHandler(async (url, body) => {
    if (url.endsWith("/leaked")) {
      tokenRequests += 100;
      return Response.json({});
    }
    if (tokenMode === "redirect discovery" && url === DISCOVERY_URL)
      return Response.redirect(`${oidcEnv.origin}/leaked`, 307);
    if (url === DISCOVERY_URL) {
      return new Response(
        JSON.stringify({
          issuer: `${oidcEnv.origin}/application/o/openship/`,
          authorization_endpoint: AUTHORIZATION_ENDPOINT,
          token_endpoint: TOKEN_ENDPOINT,
          userinfo_endpoint: USERINFO_ENDPOINT,
          jwks_uri: JWKS_ENDPOINT,
          id_token_signing_alg_values_supported: ["RS256"],
          ...discoveryOverride,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/jwks-redirect")) return Response.redirect(`${oidcEnv.origin}/leaked`, 307);
    if (url === JWKS_ENDPOINT) return Response.json({ keys: [publicKey] });
    if (url === TOKEN_ENDPOINT) {
      tokenRequests++;
      if (tokenMode === "redirect token") return Response.redirect(`${oidcEnv.origin}/leaked`, 307);
      expect(new URLSearchParams(body).get("code_verifier")).toBeTruthy();
      return new Response(
        JSON.stringify({
          id_token: await idToken(),
          access_token: "oidc-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid email profile",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === USERINFO_ENDPOINT) {
      userInfoRequests++;
      if (tokenMode === "userinfo redirect")
        return Response.redirect(`${oidcEnv.origin}/leaked`, 307);
      return new Response(JSON.stringify(idpUserInfo), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 404 });
  });
});

afterEach(() => {
  clearAuthModeCache();
});

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
  nonce = authorizationUrl.searchParams.get("nonce") ?? "";
  const state = authorizationUrl.searchParams.get("state");
  expect(state).toBeTruthy();

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

describe("OIDC generic-oauth integration", () => {
  it("does not link to an existing user and does not mark email verified when email_verified is false", async () => {
    await provisionUser({
      id: "user_existing_1",
      name: "Existing User",
      email: "existing@example.test",
      emailVerified: false,
      role: "admin",
    });

    idpUserInfo = idpProfile({
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
    await provisionUser({
      id: "user_existing_2",
      name: "Existing User",
      email: "verified@example.test",
      emailVerified: false,
      role: "admin",
    });

    idpUserInfo = idpProfile({
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

  it("enforces the invite-only gate on oidc sign-ups and leaves unverified invited sign-ups unverified", async () => {
    // Seed the instance admin so subsequent sign-ups must match an admin invitation.
    await provisionUser({
      id: "admin_1",
      name: "Instance Admin",
      email: "admin@example.test",
      emailVerified: true,
      role: "admin",
    });

    // 1. Uninvited user is rejected even when the IdP asserts email_verified=true.
    idpUserInfo = idpProfile({
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

    // 2. Invited user is allowed through the gate; with email_verified=false,
    // the new user row is created with emailVerified=false.
    await db.insert(schema.invitation).values({
      id: "inv_oidc_1",
      organizationId: "org_admin_1",
      email: "invited@example.test",
      role: "member",
      status: "pending",
      inviterId: "admin_1",
      expiresAt: new Date(Date.now() + 60_000),
    });

    idpUserInfo = idpProfile({
      sub: "oidc-sub-invited",
      email: "invited@example.test",
      email_verified: false,
      name: "Invited Member",
    });
    const invitedStart = await startOidcSignIn();
    const invitedRes = await completeOidcCallback(invitedStart.state, invitedStart.cookieHeader);
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
});

describe("OIDC callback token validation", () => {
  beforeEach(async () => {
    await provisionUser({
      id: "admin_validation",
      name: "Admin",
      email: "admin@example.test",
      emailVerified: true,
      role: "admin",
    });
    idpUserInfo = idpProfile({
      sub: "sub-admin",
      name: "Admin",
      email: "admin@example.test",
      email_verified: true,
    });
  });

  it.each([
    "unsigned",
    "missing",
    "wrong signature",
    "wrong issuer",
    "wrong audience",
    "expired",
    "future issuance",
    "missing expiry",
    "wrong nonce",
    "missing nonce",
    "wrong authorized party",
    "multiple audiences",
    "userinfo mismatch",
  ])("rejects %s without linking an account or creating a session", async (mode) => {
    tokenMode = mode;
    const start = await startOidcSignIn();
    const response = await completeOidcCallback(start.state, start.cookieHeader);
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe(
      "user_info_is_missing",
    );
    expect(await db.select().from(schema.account)).toHaveLength(0);
    expect(await db.select().from(schema.session)).toHaveLength(0);
    expect(userInfoRequests).toBe(mode === "userinfo mismatch" ? 1 : 0);
  });

  it("validates a signed token and accepts matching UserInfo without storing arbitrary claims", async () => {
    tokenMode = "userinfo";
    const start = await startOidcSignIn();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(start.authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(start.authorizationUrl.searchParams.get("code_challenge")).not.toBe(nonce);
    const response = await completeOidcCallback(start.state, start.cookieHeader);
    expect(response.headers.get("location")).toBe("http://localhost:3001/projects");
    expect(await db.select().from(schema.session)).toHaveLength(1);
    expect(userInfoRequests).toBe(1);
  });

  it("does not override a signed unverified email with UserInfo", async () => {
    tokenMode = "userinfo unverified token";
    const start = await startOidcSignIn();
    const response = await completeOidcCallback(start.state, start.cookieHeader);
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe(
      "account_not_linked",
    );
    expect(await db.select().from(schema.session)).toHaveLength(0);
  });

  it("rejects a replayed state before a second token exchange", async () => {
    const start = await startOidcSignIn();
    expect(
      (await completeOidcCallback(start.state, start.cookieHeader)).headers.get("location"),
    ).toBe("http://localhost:3001/projects");
    const replay = await completeOidcCallback(start.state, start.cookieHeader);
    expect(new URL(replay.headers.get("location")!).searchParams.get("error")).toBeTruthy();
    expect(tokenRequests).toBe(1);
    expect(await db.select().from(schema.session)).toHaveLength(1);
  });

  it.each([
    { issuer: "https://other.example.test" },
    { token_endpoint: "http://insecure.example.test/token" },
    { authorization_endpoint: "http://insecure.example.test/authorize" },
    { userinfo_endpoint: "http://insecure.example.test/userinfo" },
    { jwks_uri: "http://insecure.example.test/jwks" },
    { id_token_signing_alg_values_supported: ["none", "HS256"] },
  ])("rejects unsafe discovery before sending credentials: %j", async (overrides) => {
    discoveryOverride = overrides;
    const response = await auth.handler(
      new Request("http://localhost:4000/api/auth/sign-in/oauth2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "oidc", callbackURL: "http://localhost:3001/projects" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(tokenRequests).toBe(0);
  });
});

describe("OIDC transport and MFA", () => {
  beforeEach(async () => {
    await provisionUser({
      id: "admin_transport",
      name: "Admin",
      email: "admin@example.test",
      emailVerified: true,
      role: "admin",
    });
    idpUserInfo = idpProfile({
      sub: "sub-admin",
      name: "Admin",
      email: "admin@example.test",
      email_verified: true,
    });
  });

  it("does not follow a token endpoint redirect carrying the client secret", async () => {
    const start = await startOidcSignIn();
    tokenMode = "redirect token";
    const response = await completeOidcCallback(start.state, start.cookieHeader);
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe(
      "oauth_code_verification_failed",
    );
    expect(tokenRequests).toBe(1);
    expect(await db.select().from(schema.session)).toHaveLength(0);
  });

  it("does not follow discovery redirects", async () => {
    tokenMode = "redirect discovery";
    const response = await auth.handler(
      new Request("http://localhost:4000/api/auth/sign-in/oauth2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "oidc", callbackURL: "http://localhost:3001/projects" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(tokenRequests).toBe(0);
  });

  it.each(["userinfo redirect", "jwks redirect"])(
    "refuses a %s without forwarding credentials or trusting its claims",
    async (mode) => {
      tokenMode = mode;
      if (mode === "jwks redirect")
        discoveryOverride = { jwks_uri: `${oidcEnv.origin}/jwks-redirect` };
      const start = await startOidcSignIn();
      const response = await completeOidcCallback(start.state, start.cookieHeader);
      expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe(
        "user_info_is_missing",
      );
      expect(tokenRequests).toBe(1);
      expect(await db.select().from(schema.session)).toHaveLength(0);
    },
  );

  it("preserves the two-factor challenge after a verified OIDC callback", async () => {
    await db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.id, "admin_transport"));
    const start = await startOidcSignIn();
    const response = await completeOidcCallback(start.state, start.cookieHeader);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/two-factor");
    expect(await db.select().from(schema.session)).toHaveLength(0);
  });
});
