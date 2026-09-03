import { spawn } from "node:child_process";
import type { AcceptanceResult } from "../types.js";

export interface RunAcceptanceOptions {
  timeoutMs?: number;
  /** Extra environment variables to forward beyond the safe baseline. Never put a provider API key here. */
  extraEnv?: Record<string, string>;
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Environment variables safe to forward to the acceptance subprocess. A
 * small allowlist, not a denylist: provider API keys and other secrets are
 * never in this list, so they can only reach the subprocess if a caller
 * explicitly adds them via `extraEnv` — which nothing in this package
 * does. docs/DESIGN.md risk #3.
 */
const SAFE_ENV_KEYS = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "SystemDrive",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMSPEC",
  "SHELL",
  "NUMBER_OF_PROCESSORS",
];

function buildSafeEnv(extraEnv: Record<string, string> | undefined): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      safe[key] = value;
    }
  }
  return { ...safe, ...extraEnv };
}

/**
 * Runs a spec's acceptance command as a subprocess: a stripped environment
 * (see SAFE_ENV_KEYS), a hard timeout, and captured/truncated output.
 * `cwd` should be a scratch checkout when verifying an unreviewed diff, not
 * the live working tree — see ./scratch.ts and docs/DESIGN.md risk #3.
 */
export function runAcceptanceCommand(
  command: string,
  cwd: string,
  options: RunAcceptanceOptions = {},
): Promise<AcceptanceResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const env = buildSafeEnv(options.extraEnv);
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        cwd,
        env,
        shell: true,
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        status: "failed",
        command,
        durationMs: Date.now() - startedAt,
        reason: `failed to start: ${(err as Error).message}`,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < maxOutputBytes) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < maxOutputBytes) {
        stderr += chunk.toString("utf8");
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        status: "failed",
        command,
        durationMs: Date.now() - startedAt,
        stdout: stdout.slice(0, maxOutputBytes),
        stderr: stderr.slice(0, maxOutputBytes),
        reason: `failed to start: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;

      if (timedOut) {
        resolve({
          status: "failed",
          command,
          durationMs,
          stdout: stdout.slice(0, maxOutputBytes),
          stderr: stderr.slice(0, maxOutputBytes),
          reason: `timed out after ${timeoutMs}ms`,
        });
        return;
      }

      resolve({
        status: code === 0 ? "passed" : "failed",
        ...(code !== null ? { exitCode: code } : {}),
        command,
        durationMs,
        stdout: stdout.slice(0, maxOutputBytes),
        stderr: stderr.slice(0, maxOutputBytes),
      });
    });
  });
}

/** The envelope's acceptance result when a spec has no `acceptance` command — "unverified", never "passed". */
export function skippedAcceptance(): AcceptanceResult {
  return { status: "skipped", reason: "spec has no acceptance command configured" };
}
