import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { auth } from "@repo/platform/engine/lib/auth";
import { clearAuthModeCache } from "@repo/platform/engine/lib/auth-mode";
import { provisionUser } from "@repo/platform/engine/lib/provision-user";

afterAll(() => {
  for (const [key, value] of Object.entries(oidcEnv.previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return closeDb();
});

const DISCOVERY_URL =
  "https://idp.example.test/application/o/openship/.well-known/openid-configuration";
const AUTHORIZATION_ENDPOINT = "https://idp.example.test/application/o/authorize/";
const TOKEN_ENDPOINT = "https://idp.example.test/application/o/token/";
const USERINFO_ENDPOINT = "https://idp.example.test/application/o/userinfo/";

let idpUserInfo: Record<string, unknown> = {};

function idpProfile(profile: Record<string, unknown>): Record<string, unknown> {
  return {
    groups: ["engineering"],
    picture: "https://idp.example.test/avatar.png",
    ...profile,
  };
}
const originalFetch = globalThis.fetch;

beforeEach(async () => {
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
    if (url === DISCOVERY_URL) {
      return new Response(
        JSON.stringify({
          issuer: "https://idp.example.test/application/o/openship/",
          authorization_endpoint: AUTHORIZATION_ENDPOINT,
          token_endpoint: TOKEN_ENDPOINT,
          userinfo_endpoint: USERINFO_ENDPOINT,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === TOKEN_ENDPOINT) {
      return new Response(
        JSON.stringify({
          access_token: "oidc-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid email profile",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === USERINFO_ENDPOINT) {
      return new Response(JSON.stringify(idpUserInfo), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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
});
