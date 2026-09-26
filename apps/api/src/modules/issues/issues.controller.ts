/** HTTP codecs over shared issue aggregation and the retained health/job services. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
import { ValidationError } from "@repo/core";
const issues = () => getPlatformKernel().issues;
export async function listIssues(c: Context) {
  const result = await operationData(c, issues().list(operationContext(c), { status: c.req.query("status") === "resolved" ? "resolved" : "open" }));
  return c.json({ data: result.issues, counts: result.counts, status: result.status });
}
export async function issuesSummary(c: Context) {
  return c.json({ data: await operationData(c, issues().summary(operationContext(c))) });
}
export async function healthSnapshot(c: Context) {
  const { workloads, ...rest } = await operationData(c, issues().health(operationContext(c)));
  return c.json({ data: workloads, ...rest });
}
export async function scanCurrentHealth(c: Context) {
  return c.json({ data: await operationData(c, issues().scanHealth(operationContext(c))) });
}
export async function rescanStatus(c: Context) {
  return c.json({ data: await operationData(c, issues().rescanStatus(operationContext(c))) });
}
export async function rescanIssues(c: Context) {
  const text = await c.req.text();
  let input;
  try { input = text.trim() ? JSON.parse(text) : undefined; }
  catch { throw new ValidationError("Invalid JSON body"); }
  return c.json({ data: await operationData(c, issues().rescan(operationContext(c), input)) }, 202);
}
