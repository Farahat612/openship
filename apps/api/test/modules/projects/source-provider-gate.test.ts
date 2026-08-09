import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { SOURCE_PROVIDERS } from "@repo/core";
import {
  CreateProjectBody,
  EnsureProjectBody,
} from "../../../src/modules/projects/project.schema";

/**
 * `project.git_provider` is a CHECKED union (SOURCE_PROVIDERS in @repo/core)
 * applied to the columns and every write site — but the type system stops at
 * the HTTP edge. `gitProvider` arrives as a raw string from the dashboard, the
 * CLI (`/projects/ensure` with `gitProvider:"upload"`) and MCP, so the body
 * validator is what keeps an unlisted provider out of the column. This covers
 * that gate; the compile-time half needs no test.
 */
describe("gitProvider — API boundary gate", () => {
  it("accepts every canonical provider on create and ensure", () => {
    for (const provider of SOURCE_PROVIDERS) {
      expect(Value.Check(CreateProjectBody, { name: "x", gitProvider: provider })).toBe(true);
      expect(Value.Check(EnsureProjectBody, { name: "x", gitProvider: provider })).toBe(true);
    }
  });

  it("rejects a provider outside the union, pointing at the field", () => {
    // The case this exists for: a second provider spelled slightly wrong would
    // otherwise land in the column as free text and read back as a lie.
    const body = { name: "x", gitProvider: "gitlabs" };
    expect(Value.Check(CreateProjectBody, body)).toBe(false);
    expect(Value.Check(EnsureProjectBody, body)).toBe(false);

    const errors = [...Value.Errors(CreateProjectBody, body)];
    expect(errors.some((e) => e.path === "/gitProvider")).toBe(true);
  });

  it("still treats gitProvider as optional (callers that omit it get the default)", () => {
    expect(Value.Check(CreateProjectBody, { name: "x" })).toBe(true);
    expect(Value.Check(EnsureProjectBody, { name: "x" })).toBe(true);
  });
});
