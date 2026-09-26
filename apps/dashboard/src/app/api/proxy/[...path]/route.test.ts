import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET, POST } from "./route";

const upstreamFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_API_PROXY", "true");
  vi.stubEnv("INTERNAL_API_URL", "http://api:4000");
  vi.stubGlobal("fetch", upstreamFetch);
  upstreamFetch.mockResolvedValue(new Response(null, { status: 401 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  upstreamFetch.mockReset();
});

describe("MCP through the dashboard API proxy", () => {
  it.each([
    ["GET", "/api/mcp"],
    ["POST", "/api/mcp"],
    ["GET", "/api/proxy/api/mcp"],
    ["POST", "/api/proxy/api/mcp"],
  ])("preserves the public path for %s %s", async (method, path) => {
    // Next's /api/mcp rewrite selects this handler with the same params as an
    // explicit /api/proxy/api/mcp request, but req.url retains the public URL.
    const request = new NextRequest(`https://ops.example.com${path}?client=desktop`, {
      method,
      headers: { "x-forwarded-uri": "/attacker-supplied-path" },
    });
    const handler = method === "GET" ? GET : POST;

    const response = await handler(request, { params: Promise.resolve({ path: ["api", "mcp"] }) });

    expect(response.status).toBe(401);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    const [url, init] = upstreamFetch.mock.calls[0]!;
    expect(String(url)).toBe("http://api:4000/api/mcp?client=desktop");
    expect(init?.method).toBe(method);
    const headers = new Headers(init?.headers);
    expect(headers.get("x-forwarded-uri")).toBe(path);
    expect(headers.get("x-forwarded-host")).toBe("ops.example.com");
    expect(headers.get("x-forwarded-proto")).toBe("https");
  });
});
