import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
} from "jose";
import { oidcEndpointAllowed } from "@repo/platform/engine/lib/oidc-endpoint";

const diagnosticsWarn = vi.hoisted(() => vi.fn());
const reportCaught = vi.hoisted(() => vi.fn());

vi.mock("@repo/core/diagnostics", () => ({
  diagnostics: { warn: diagnosticsWarn, error: vi.fn() },
  reportCaughtError: reportCaught,
}));

/**
 * Which social logins does this instance actually have credentials for?
 *
 * The dashboard used to answer that question itself, with `!selfHosted` — a
 * proxy that is wrong in both directions (a self-hosted operator WITH GitHub
 * creds got no button; a cloud deploy missing a pair would have got a button
 * that dead-ends). The answer now comes from the server, derived from the same
 * predicate that decides whether Better Auth registers the provider at all.
 *
 * These tests pin the two halves that matter:
 *   1. configured → advertised, not configured → absent (and half-configured
 *      counts as NOT configured — a client id with no secret cannot complete a
 *      redirect flow);
 *   2. the advertised payload carries IDs and nothing else. This list is served
 *      unauthenticated, so a client id leaking into it is a real disclosure, and
 *      it would leak by the most ordinary of edits: returning the config object
 *      the registration path already builds.
 */

const env: Record<string, string | undefined> = {};

vi.mock("@repo/platform/engine/config/env", () => ({
  get env() {
    return env;
  },
}));

async function load() {
  vi.resetModules();
  return import("@repo/platform/engine/lib/auth-providers");
}

afterEach(() => {
  for (const key of Object.keys(env)) delete env[key];
  diagnosticsWarn.mockClear();
  reportCaught.mockClear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("configuredAuthProviders", () => {
  it("advertises nothing on a default self-hosted instance", async () => {
    const { configuredAuthProviders } = await load();
    // No creds in env — password login only. The dashboard renders no buttons,
    // which is the same thing an operator sees today, just for a true reason.
    expect(configuredAuthProviders()).toEqual([]);
  });

  it("advertises a provider once both halves of its credential pair are set", async () => {
    env.GITHUB_CLIENT_ID = "Iv1.self-hosted-app";
    env.GITHUB_CLIENT_SECRET = "shhh-github";

    const { configuredAuthProviders } = await load();
    // The improvement this whole change exists for: a self-hosted operator who
    // DID configure GitHub now gets the button, where before it was hidden.
    expect(configuredAuthProviders()).toEqual([{ id: "github", kind: "social" }]);
  });

  it("omits a half-configured provider — an id without a secret cannot sign anyone in", async () => {
    env.GITHUB_CLIENT_ID = "Iv1.half-done";
    env.GOOGLE_CLIENT_SECRET = "secret-without-an-id";

    const { configuredAuthProviders } = await load();
    expect(configuredAuthProviders()).toEqual([]);
  });

  it("advertises both, in a stable order, when both are configured (the cloud case)", async () => {
    env.GITHUB_CLIENT_ID = "gh-id";
    env.GITHUB_CLIENT_SECRET = "gh-secret";
    env.GOOGLE_CLIENT_ID = "goog-id";
    env.GOOGLE_CLIENT_SECRET = "goog-secret";

    const { configuredAuthProviders } = await load();
    expect(configuredAuthProviders().map((p) => p.id)).toEqual(["github", "google"]);
  });

  it("advertises oidc with default display name when issuer, client id, and secret are all set", async () => {
    env.OIDC_ISSUER = "https://idp.example.com";
    env.OIDC_CLIENT_ID = "oidc-client";
    env.OIDC_CLIENT_SECRET = "oidc-secret";

    const { configuredAuthProviders } = await load();
    expect(configuredAuthProviders()).toEqual([
      { id: "oidc", kind: "oidc", name: "SSO" },
    ]);
  });

  it("advertises oidc with custom OIDC_DISPLAY_NAME when configured", async () => {
    env.OIDC_ISSUER = "https://idp.example.com";
    env.OIDC_CLIENT_ID = "oidc-client";
    env.OIDC_CLIENT_SECRET = "oidc-secret";
    env.OIDC_DISPLAY_NAME = "  Authentik  ";

    const { configuredAuthProviders } = await load();
    expect(configuredAuthProviders()).toEqual([
      { id: "oidc", kind: "oidc", name: "Authentik" },
    ]);
  });

  it("omits oidc when only a partial set of OIDC env vars is configured", async () => {
    env.OIDC_ISSUER = "https://idp.example.com";
    env.OIDC_CLIENT_ID = "oidc-client";

    const { configuredAuthProviders } = await load();
    expect(configuredAuthProviders()).toEqual([]);
    expect(diagnosticsWarn).toHaveBeenCalledWith(
      "platform/engine/lib/auth-providers",
      expect.stringContaining("OIDC_CLIENT_SECRET"),
    );
  });

  it("never puts a client id or secret in the advertised payload", async () => {
    env.GITHUB_CLIENT_ID = "Iv1.SECRET-CLIENT-ID";
    env.GITHUB_CLIENT_SECRET = "SECRET-CLIENT-SECRET";
    env.GOOGLE_CLIENT_ID = "google-SECRET-CLIENT-ID";
    env.GOOGLE_CLIENT_SECRET = "google-SECRET-CLIENT-SECRET";
    env.OIDC_ISSUER = "https://idp.example.com/secret-tenant";
    env.OIDC_CLIENT_ID = "oidc-SECRET-CLIENT-ID";
    env.OIDC_CLIENT_SECRET = "oidc-SECRET-CLIENT-SECRET";

    const { configuredAuthProviders } = await load();
    const serialized = JSON.stringify(configuredAuthProviders());

    for (const value of Object.values(env)) {
      expect(serialized).not.toContain(value);
    }
    // Belt and braces: the only keys are the documented ones, so a future
    // field can't be added without a test author looking at this assertion.
    expect(Object.keys(configuredAuthProviders()[0]!).sort()).toEqual(["id", "kind"]);
    expect(Object.keys(configuredAuthProviders()[2]!).sort()).toEqual(["id", "kind", "name"]);
  });
});

describe("socialProviderCredentials", () => {
  it("hands the registration path both halves when configured", async () => {
    env.GOOGLE_CLIENT_ID = "goog-id";
    env.GOOGLE_CLIENT_SECRET = "goog-secret";

    const { socialProviderCredentials } = await load();
    expect(socialProviderCredentials("google")).toEqual({
      clientId: "goog-id",
      clientSecret: "goog-secret",
    });
    expect(socialProviderCredentials("github")).toBeNull();
  });
});

describe("oidcProviderConfig", () => {
  it("registers oidc only when issuer, client id, and client secret are all present", async () => {
    env.OIDC_ISSUER = "https://idp.example.com/application/o/openship/";
    env.OIDC_CLIENT_ID = "oidc-client-id";
    env.OIDC_CLIENT_SECRET = "oidc-client-secret";

    const { oidcProviderConfig } = await load();
    const config = oidcProviderConfig();
    expect(config).toBeDefined();
    expect(config).toMatchObject({
      providerId: "oidc",
      discoveryUrl: "https://idp.example.com/application/o/openship/.well-known/openid-configuration",
      clientId: "oidc-client-id",
      clientSecret: "oidc-client-secret",
      scopes: ["openid", "email", "profile"],
      pkce: true,
      displayName: "SSO",
    });
    expect(typeof config?.getUserInfo).toBe("function");
    expect(typeof config?.getToken).toBe("function");
  });

  it("registers nothing and warns once per distinct partial OIDC env", async () => {
    const { oidcProviderConfig } = await load();

    env.OIDC_DISPLAY_NAME = "Okta";
    expect(oidcProviderConfig()).toBeUndefined();
    expect(diagnosticsWarn).not.toHaveBeenCalled();

    env.OIDC_ISSUER = "https://idp.example.com";
    expect(oidcProviderConfig()).toBeUndefined();
    expect(diagnosticsWarn).toHaveBeenCalledTimes(1);
    expect(diagnosticsWarn.mock.calls[0]?.[1]).toContain("OIDC_CLIENT_ID");
    expect(diagnosticsWarn.mock.calls[0]?.[1]).toContain("OIDC_CLIENT_SECRET");
    oidcProviderConfig();
    expect(diagnosticsWarn).toHaveBeenCalledTimes(1);

    delete env.OIDC_ISSUER;
    env.OIDC_CLIENT_ID = "only-id";
    env.OIDC_CLIENT_SECRET = "only-secret";
    expect(oidcProviderConfig()).toBeUndefined();
    expect(diagnosticsWarn).toHaveBeenCalledTimes(2);
    expect(diagnosticsWarn.mock.calls[1]?.[1]).toContain("OIDC_ISSUER");
  });
});

describe("mapOidcProfileToUser", () => {
  it("trusts email_verified only when it is boolean true", async () => {
    const { mapOidcProfileToUser } = await load();

    expect(mapOidcProfileToUser({
      sub: "u1",
      email: "alice@example.test",
      name: "Alice",
      email_verified: true,
    })).toEqual({ name: "Alice", emailVerified: true });

    expect(mapOidcProfileToUser({
      email: "alice@example.test",
      name: "Alice",
      email_verified: false,
      emailVerified: true,
    })).toEqual({ name: "Alice", emailVerified: false });

    expect(mapOidcProfileToUser({
      email: "alice@example.test",
      name: "Alice",
      email_verified: "true",
    })).toEqual({ name: "Alice", emailVerified: false });

    expect(mapOidcProfileToUser({
      email: "alice@example.test",
      emailVerified: true,
    })).toEqual({ name: "alice", emailVerified: true });

    expect(mapOidcProfileToUser({
      email: "alice@example.test",
    })).toEqual({ name: "alice", emailVerified: false });
  });
});

describe("oidc endpoint scheme", () => {
  it("requires https in production and still allows loopback http", () => {
    expect(oidcEndpointAllowed(new URL("https://idp.example.com"), "production")).toBe(true);
    expect(oidcEndpointAllowed(new URL("http://idp.example.com"), "production")).toBe(false);
    expect(oidcEndpointAllowed(new URL("http://127.0.0.1.example.com"), "production")).toBe(false);
    expect(oidcEndpointAllowed(new URL("http://127.0.0.1:8080/realms/openship"), "production")).toBe(true);
    expect(oidcEndpointAllowed(new URL("http://localhost/realms/openship"), "production")).toBe(true);
    expect(oidcEndpointAllowed(new URL("http://[::1]/realms/openship"), "production")).toBe(true);
    expect(oidcEndpointAllowed(new URL("http://idp.example.com"), "test")).toBe(true);
    expect(oidcEndpointAllowed(new URL("http://idp.example.com"), "development")).toBe(true);
  });
});

describe("oidc getUserInfo", () => {
  const issuer = "https://idp.example.com";
  const jwksUrl = "https://idp.example.com/jwks";
  const userinfoUrl = "https://idp.example.com/userinfo";
  let privateKey: CryptoKey;
  let kid = "";
  let publicJwk: Record<string, unknown>;

  async function sign(claims: Record<string, unknown>, expiresIn = 600): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(issuer)
      .setSubject(String(claims.sub))
      .setAudience("oidc-client")
      .setIssuedAt(now)
      .setExpirationTime(now + expiresIn)
      .sign(privateKey);
  }

  function discovery(extra: Record<string, unknown> = {}) {
    return {
      issuer,
      jwks_uri: jwksUrl,
      authorization_endpoint: "https://idp.example.com/authorize",
      token_endpoint: "https://idp.example.com/token",
      userinfo_endpoint: userinfoUrl,
      id_token_signing_alg_values_supported: ["RS256", "none", "HS256"],
      ...extra,
    };
  }

  async function useIdp() {
    env.OIDC_ISSUER = `${issuer}/`;
    env.OIDC_CLIENT_ID = "oidc-client";
    env.OIDC_CLIENT_SECRET = "oidc-secret";
    env.NODE_ENV = "test";
    const { publicKey, privateKey: key } = await generateKeyPair("RS256", { extractable: true });
    privateKey = key;
    const jwk = await exportJWK(publicKey);
    kid = await calculateJwkThumbprint(jwk);
    jwk.kid = kid;
    jwk.alg = "RS256";
    jwk.use = "sig";
    publicJwk = jwk;
  }

  it("does not accept userinfo when the token response has no id_token", async () => {
    await useIdp();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify(discovery()), { status: 200 });
      }
      if (url === userinfoUrl) {
        return new Response(JSON.stringify({
          sub: "sub-1",
          email: "ada@example.com",
          email_verified: true,
          name: "Ada",
          groups: ["admins"],
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { oidcProviderConfig } = await load();
    const user = await oidcProviderConfig()?.getUserInfo?.({ accessToken: "token" });
    expect(user).toBeNull();
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain(userinfoUrl);
  });

  it("reads email_verified only from the verified id token and drops raw claims", async () => {
    await useIdp();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify(discovery()), { status: 200 });
      }
      if (url === jwksUrl) return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
      if (url === userinfoUrl) {
        return new Response(JSON.stringify({
          sub: "sub-1",
          email: "ada@example.com",
          email_verified: "true",
          name: "Ada",
          groups: ["admins"],
          picture: "https://idp.example.com/ada.png",
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { oidcProviderConfig } = await load();
    const getUserInfo = oidcProviderConfig()?.getUserInfo;
    const unverified = await getUserInfo?.({
      idToken: await sign({ sub: "sub-1", email: "ada@example.com", email_verified: "true", name: "Ada" }),
      accessToken: "token",
    });
    expect(unverified).toEqual({
      id: "sub-1",
      email: "ada@example.com",
      emailVerified: false,
      name: "Ada",
      image: "https://idp.example.com/ada.png",
    });
    expect(unverified).not.toHaveProperty("groups");
    expect(unverified).not.toHaveProperty("email_verified");

    fetchMock.mockClear();
    const verified = await getUserInfo?.({
      idToken: await sign({
        sub: "sub-3",
        email: "ada@example.com",
        email_verified: true,
        preferred_username: "ada",
      }),
    });
    expect(verified).toEqual({
      id: "sub-3",
      email: "ada@example.com",
      emailVerified: true,
      name: "ada",
    });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain(userinfoUrl);
  });

  it("does not fall back to userinfo when the id token cannot be verified", async () => {
    await useIdp();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify(discovery()), { status: 200 });
      }
      if (url === userinfoUrl) {
        return new Response(JSON.stringify({
          sub: "sub-4",
          email: "ada@example.com",
          email_verified: true,
          name: "Ada",
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { oidcProviderConfig } = await load();
    const user = await oidcProviderConfig()?.getUserInfo?.({
      idToken: "not-a-jwt",
      accessToken: "token",
    });
    expect(user).toBeNull();
    expect(reportCaught).toHaveBeenCalled();
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain(userinfoUrl);
  });

  it("refreshes discovery after one hour and verifies with the rotated jwks_uri", async () => {
    await useIdp();
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const rotatedJwksUrl = "https://idp.example.com/rotated-jwks";
    let discoveryRequests = 0;
    let rejected = false;
    const fetchedJwks: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        discoveryRequests++;
        return new Response(JSON.stringify(discovery({
          jwks_uri: discoveryRequests === 1 ? jwksUrl : rotatedJwksUrl,
        })), { status: rejected ? 503 : 200 });
      }
      if (url === jwksUrl || url === rotatedJwksUrl) {
        fetchedJwks.push(url);
        return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    const { oidcProviderConfig } = await load();
    const getUserInfo = oidcProviderConfig()!.getUserInfo!;
    const tokens = async () => ({ idToken: await sign({ sub: "sub-ttl", email: "ada@example.com" }) });
    expect(await getUserInfo(await tokens())).toMatchObject({ id: "sub-ttl" });
    vi.setSystemTime(now + 3_600_000 - 1);
    expect(await getUserInfo(await tokens())).toMatchObject({ id: "sub-ttl" });
    expect(discoveryRequests).toBe(1);
    vi.setSystemTime(now + 3_600_000);
    expect(await getUserInfo(await tokens())).toMatchObject({ id: "sub-ttl" });
    expect(discoveryRequests).toBe(2);
    expect(fetchedJwks).toContain(rotatedJwksUrl);

    rejected = true;
    vi.setSystemTime(now + 7_200_000);
    expect(await getUserInfo(await tokens())).toBeNull();
    expect(await getUserInfo(await tokens())).toBeNull();
    expect(discoveryRequests).toBe(4);
    rejected = false;
    expect(await getUserInfo(await tokens())).toMatchObject({ id: "sub-ttl" });
    expect(discoveryRequests).toBe(5);
  });

  it("refuses an http issuer in production before fetching discovery", async () => {
    env.NODE_ENV = "production";
    env.OIDC_ISSUER = "http://idp.example.com";
    env.OIDC_CLIENT_ID = "oidc-client";
    env.OIDC_CLIENT_SECRET = "oidc-secret";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { oidcProviderConfig } = await load();
    const user = await oidcProviderConfig()?.getUserInfo?.({
      idToken: "header.payload.sig",
      accessToken: "token",
    });
    expect(user).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
