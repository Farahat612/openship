import { getPlatform } from "@repo/adapters";
import { AppError } from "@repo/core";
import { env } from "../../config/env";
import { nativeJobsEnabled } from "../../native/execution-policy";

export const HEALTH_WATCH_JOB = "services:health-watch";

/** Local/SSH Docker observation is never a cloud-runtime capability. */
export function containerHealthSupported(): boolean {
  return !env.CLOUD_MODE && getPlatform().target !== "cloud";
}

export function assertContainerHealthSupported(): void {
  if (!containerHealthSupported()) {
    throw new AppError(
      "Container monitoring is not available in cloud mode",
      404,
      "CAPABILITY_UNAVAILABLE",
    );
  }
}

/** Desktop can use the same worker for as long as its API process is running. */
export function continuousHealthAvailable(): boolean {
  return containerHealthSupported() && nativeJobsEnabled();
}

export function containerHealthEventsAvailable(): boolean {
  return continuousHealthAvailable() && !env.OPENSHIP_DISABLE_CONTAINER_EVENTS;
}

export function healthWatchActive(
  job: {
    enabled: boolean;
    scheduleType: string;
    cronExpression: string | null;
  } | null,
): boolean {
  return (
    continuousHealthAvailable() &&
    !!job?.enabled &&
    job.scheduleType === "recurring" &&
    !!job.cronExpression
  );
}
