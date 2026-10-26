/**
 * HTTPS rules for a generic OIDC issuer and the endpoints it publishes.
 * Production refuses plain http except for a loopback IdP. Other environments
 * (development, test) may use http so a local identity provider can sign in.
 */

const OIDC_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function loopbackHost(hostname: string): boolean {
  // Bun keeps the brackets on an IPv6 hostname (`[::1]`). Node often strips them.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return OIDC_LOOPBACK_HOSTS.has(host);
}

export function oidcEndpointAllowed(url: URL, nodeEnv: string): boolean {
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  if (nodeEnv !== "production") return true;
  return loopbackHost(url.hostname);
}
