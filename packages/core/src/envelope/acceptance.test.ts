import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAcceptanceCommand, skippedAcceptance } from "./acceptance.js";

describe("skippedAcceptance", () => {
  it("is 'skipped', never 'passed'", () => {
    expect(skippedAcceptance()).toEqual({
      status: "skipped",
      reason: "spec has no acceptance command configured",
    });
  });
});

describe("runAcceptanceCommand", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "thp-acceptance-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a passing command with exit code 0", async () => {
    const result = await runAcceptanceCommand('node -e "process.exit(0)"', dir);
    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
  });

  it("reports a failing command with its non-zero exit code", async () => {
    const result = await runAcceptanceCommand('node -e "process.exit(3)"', dir);
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
  });

  it("captures stdout and stderr", async () => {
    const result = await runAcceptanceCommand(
      'node -e "console.log(\'out-marker\'); console.error(\'err-marker\'); process.exit(1)"',
      dir,
    );
    expect(result.stdout).toContain("out-marker");
    expect(result.stderr).toContain("err-marker");
  });

  it("kills a command that exceeds the timeout and reports why", async () => {
    const result = await runAcceptanceCommand('node -e "setTimeout(() => {}, 5000)"', dir, {
      timeoutMs: 200,
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/timed out/);
  }, 10_000);

  it("runs in the given cwd", async () => {
    const result = await runAcceptanceCommand(
      'node -e "console.log(process.cwd())"',
      dir,
    );
    // Resolve both sides through fs realpath-equivalent normalization by
    // just checking containment — Windows may report an 8.3 or differently
    // cased path segment for temp dirs.
    expect(result.stdout?.trim().toLowerCase()).toContain(path.basename(dir).toLowerCase());
  });

  it("does not forward arbitrary environment variables into the subprocess", async () => {
    process.env.THP_TEST_SECRET = "super-secret-value";
    try {
      const result = await runAcceptanceCommand(
        'node -e "console.log(String(process.env.THP_TEST_SECRET))"',
        dir,
      );
      expect(result.stdout).not.toContain("super-secret-value");
      expect(result.stdout?.trim()).toBe("undefined");
    } finally {
      delete process.env.THP_TEST_SECRET;
    }
  });

  it("forwards only explicitly allowed extraEnv entries", async () => {
    const result = await runAcceptanceCommand(
      'node -e "console.log(String(process.env.THP_ALLOWED))"',
      dir,
      { extraEnv: { THP_ALLOWED: "yes" } },
    );
    expect(result.stdout?.trim()).toBe("yes");
  });
});
