import { describe, it, expect } from "vitest";
import {
  loadEndpoint,
  mapAnalyticsData,
  type AnalyticsOverviewResponse,
} from "./useProjectEndpoints";

/**
 * An aborted request must never be rendered as data (#396).
 *
 * The project overview showed "Server Requests 0 / Unique IPs 0 / Avg Response
 * N/A" and "No traffic data yet" on projects whose analytics endpoint answered
 * perfectly well when asked again — the console error on those loads was
 * `AbortError: signal is aborted without reason`, i.e. `api.get`'s own request
 * timeout firing on a request it had deduped onto an older in-flight one. The
 * load path turned that rejection into `{ data: null, isLoading: false }`, which
 * the overview reads exactly like "loaded, and there is no traffic" — and since
 * nothing in the effect's deps changes afterwards, it never refetched.
 *
 * These drive `loadEndpoint`, the async load+dedup+retry core that the
 * `useEndpoint` effect is a thin wrapper around. The dashboard has no React test
 * harness (no jsdom, no testing-library — see MonitoringView.test.tsx, which
 * server-renders for the same reason), so this is the seam where the behaviour
 * is testable without installing one.
 */

/** Verbatim shape of the browser's rejection: `controller.abort()` with no reason. */
const abortError = () => new DOMException("signal is aborted without reason", "AbortError");

/** The reporter's numbers, so a pass means the real figures reach the cards. */
const OVERVIEW: AnalyticsOverviewResponse = {
  summary: {
    totalRequests: 3057,
    pageRequests: 1204,
    uniqueVisitors: null,
    bandwidthIn: 1_048_576,
    bandwidthOut: 8_388_608,
    avgResponseTimeMs: 42.5,
    lastUpdated: "2026-08-09T12:00:00.000Z",
  },
  periods: [
    {
      from: "2026-08-09T10:00:00.000Z",
      to: "2026-08-09T11:00:00.000Z",
      requests: 1500,
      uniqueVisitors: 90,
      bandwidthIn: 524_288,
      bandwidthOut: 4_194_304,
      avgResponseTimeMs: 40,
    },
  ],
};

/** Collects the backoff it was asked for instead of waiting on real timers. */
function fakeDelay() {
  const waited: number[] = [];
  return {
    waited,
    delay: (ms: number) => {
      waited.push(ms);
      return Promise.resolve();
    },
  };
}

describe("loadEndpoint", () => {
  it("retries an aborted load instead of settling it as empty data", async () => {
    const cache = new Map();
    const { waited, delay } = fakeDelay();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      if (calls === 1) throw abortError();
      return OVERVIEW;
    };

    const result = await loadEndpoint("proj_1", cache, fetcher, delay);

    // Pre-fix this was `{ kind: "error" }` with no data — which the overview
    // renders as four zeros and an empty traffic chart, permanently.
    expect(result).toEqual({ kind: "ready", data: OVERVIEW });
    expect(calls).toBe(2);
    expect(waited).toEqual([400]);
  });

  it("delivers the real numbers to the cards after an abort", async () => {
    const cache = new Map();
    const { delay } = fakeDelay();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      if (calls === 1) throw abortError();
      return OVERVIEW;
    };

    const result = await loadEndpoint("proj_1", cache, fetcher, delay);
    const mapped =
      result.kind === "ready" ? mapAnalyticsData(result.data.summary, result.data.periods, "x.dev") : null;

    // `mapAnalyticsData` returning null is what OverviewTab reads as
    // "No traffic data yet"; the zeros come from the same null.
    expect(mapped).not.toBeNull();
    expect(mapped?.summary.totalRequests).toBe(3057);
    expect(mapped?.trafficByHour).toHaveLength(1);
  });

  it("backs off between retries and gives up after the limit", async () => {
    const cache = new Map();
    const { waited, delay } = fakeDelay();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      throw abortError();
    };

    const result = await loadEndpoint("proj_1", cache, fetcher, delay);

    expect(result).toEqual({ kind: "error", message: "signal is aborted without reason" });
    expect(calls).toBe(3);
    expect(waited).toEqual([400, 800]);
    // Nothing cached — a remount or an invalidation still gets a fresh attempt.
    expect(cache.size).toBe(0);
  });

  it("reports a real failure immediately, without retrying", async () => {
    const cache = new Map();
    const { waited, delay } = fakeDelay();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      throw new Error("Failed to load analytics");
    };

    const result = await loadEndpoint("proj_1", cache, fetcher, delay);

    expect(result).toEqual({ kind: "error", message: "Failed to load analytics" });
    expect(calls).toBe(1);
    expect(waited).toEqual([]);
  });

  it("still dedups concurrent loads onto one fetch and caches the result", async () => {
    const cache = new Map();
    const { delay } = fakeDelay();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return OVERVIEW;
    };

    // OverviewTab and MonitoringTab mounting together.
    const [a, b] = await Promise.all([
      loadEndpoint("proj_1", cache, fetcher, delay),
      loadEndpoint("proj_1", cache, fetcher, delay),
    ]);

    expect(calls).toBe(1);
    expect(a).toEqual({ kind: "ready", data: OVERVIEW });
    expect(b).toEqual(a);
    expect(cache.get("proj_1")).toEqual({ kind: "ready", data: OVERVIEW });
  });
});
