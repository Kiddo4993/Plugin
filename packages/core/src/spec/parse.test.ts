import { describe, expect, it } from "vitest";
import { SpecParseError } from "../types.js";
import { parseSpec } from "./parse.js";

describe("parseSpec", () => {
  it("parses a minimal 5-line spec with all defaults filled in", () => {
    const raw = [
      "---",
      "taskType: bugfix",
      "---",
      "# Fix flaky retry test",
      "The retry test fails under load; make it deterministic.",
    ].join("\n");

    const spec = parseSpec(raw, { sourcePath: "/repo/fix-flaky-retry-test.thp.md" });

    expect(spec.taskType).toBe("bugfix");
    expect(spec.id).toBe("fix-flaky-retry-test");
    expect(spec.contextGlobs).toEqual([]);
    expect(spec.constraints).toEqual([]);
    expect(spec.expects).toBe("diff");
    expect(spec.acceptance).toBeUndefined();
    expect(spec.budget).toBeUndefined();
    expect(spec.pinnedProvider).toBeUndefined();
    expect(spec.body.startsWith("# Fix flaky retry test")).toBe(true);
  });

  it("defaults id to 'untitled-spec' when no sourcePath is given", () => {
    const raw = ["---", "taskType: docs", "---", "body"].join("\n");
    const spec = parseSpec(raw);
    expect(spec.id).toBe("untitled-spec");
  });

  it("parses every field on a fully-populated spec", () => {
    const raw = [
      "---",
      "id: my-task",
      "taskType: codegen",
      "contextGlobs:",
      "  - src/a.ts",
      "  - src/b.ts",
      "acceptance: pnpm test",
      "constraints:",
      "  - no new dependencies",
      "budget:",
      "  maxUsd: 0.5",
      "  maxLatencyMs: 120000",
      "pinnedProvider: anthropic:claude-sonnet-5",
      "expects: artifact",
      "---",
      "# Title",
      "Body text.",
    ].join("\n");

    const spec = parseSpec(raw);

    expect(spec).toMatchObject({
      id: "my-task",
      taskType: "codegen",
      contextGlobs: ["src/a.ts", "src/b.ts"],
      acceptance: "pnpm test",
      constraints: ["no new dependencies"],
      budget: { maxUsd: 0.5, maxLatencyMs: 120000 },
      pinnedProvider: "anthropic:claude-sonnet-5",
      expects: "artifact",
    });
    expect(spec.body).toBe("# Title\nBody text.");
  });

  it("rejects a file with no frontmatter, naming $root at line 1", () => {
    expect.assertions(4);
    try {
      parseSpec("just some text");
    } catch (err) {
      expect(err).toBeInstanceOf(SpecParseError);
      const e = err as SpecParseError;
      expect(e.issues).toHaveLength(1);
      expect(e.issues[0]).toMatchObject({ field: "$root", line: 1, column: 1 });
      expect(e.message).toContain("$root");
    }
  });

  it("names the missing required field and points at the object missing it", () => {
    const raw = ["---", "id: my-spec", "---", "body"].join("\n");
    expect.assertions(3);
    try {
      parseSpec(raw);
    } catch (err) {
      const e = err as SpecParseError;
      expect(e.issues).toHaveLength(1);
      expect(e.issues[0]?.field).toBe("taskType");
      expect(e.issues[0]?.line).toBe(2);
    }
  });

  it("names an unrecognized field and its own line number", () => {
    const raw = ["---", "taskType: bugfix", "typoField: oops", "---", "body"].join("\n");
    expect.assertions(2);
    try {
      parseSpec(raw);
    } catch (err) {
      const e = err as SpecParseError;
      expect(e.issues[0]?.field).toBe("typoField");
      expect(e.issues[0]?.line).toBe(3);
    }
  });

  it("names a nested field with the wrong type and its exact line", () => {
    const raw = [
      "---",
      "taskType: bugfix",
      "budget:",
      '  maxUsd: "not a number"',
      "---",
      "body",
    ].join("\n");
    expect.assertions(2);
    try {
      parseSpec(raw);
    } catch (err) {
      const e = err as SpecParseError;
      expect(e.issues[0]?.field).toBe("budget.maxUsd");
      expect(e.issues[0]?.line).toBe(4);
    }
  });

  it("rejects a malformed pinnedProvider", () => {
    const raw = ["---", "taskType: bugfix", "pinnedProvider: 'not valid!!'", "---", "body"].join(
      "\n",
    );
    expect(() => parseSpec(raw)).toThrow(SpecParseError);
  });

  it("rejects invalid YAML syntax with a line number, not a generic failure", () => {
    const raw = ["---", "taskType: [unterminated", "---", "body"].join("\n");
    expect.assertions(3);
    try {
      parseSpec(raw);
    } catch (err) {
      expect(err).toBeInstanceOf(SpecParseError);
      const e = err as SpecParseError;
      expect(e.issues.length).toBeGreaterThan(0);
      expect(e.issues[0]?.line).toBeGreaterThanOrEqual(2);
    }
  });

  it("rejects an acceptance-less spec fine (acceptance is optional)", () => {
    const raw = ["---", "taskType: docs", "---", "write release notes"].join("\n");
    const spec = parseSpec(raw);
    expect(spec.acceptance).toBeUndefined();
  });
});
