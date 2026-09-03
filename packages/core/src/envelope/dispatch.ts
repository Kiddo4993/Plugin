import type { Router } from "../router/router.js";
import type {
  AcceptanceResult,
  AcceptanceStatus,
  CapabilityProfile,
  DispatchArtifact,
  DispatchAttempt,
  DispatchContext,
  DispatchUsage,
  ResultEnvelope,
  RouteOptions,
  TaskSpec,
  TelemetryStore,
} from "../types.js";
import { runAcceptanceCommand, skippedAcceptance } from "./acceptance.js";
import { NotAGitRepoError, withScratchWorktree } from "./scratch.js";

export interface DispatchOptions {
  routeOptions?: RouteOptions;
  signal?: AbortSignal;
  /**
   * Verify a "diff" dispatch's acceptance command in a scratch git
   * worktree rather than the live working tree. Defaults to true; set
   * false to run acceptance directly against ctx.workspaceRoot (e.g.
   * non-git workspaces, or when you've already reviewed and applied the
   * diff yourself).
   */
  useScratchWorktree?: boolean;
}

/**
 * Runs a TaskSpec through the router's fallback chain: tries each
 * candidate in order, verifies its output, records telemetry for every
 * attempt (pass or fail), and stops at the first candidate that passes
 * (or is unverified because the spec has no acceptance command). The
 * budget ceiling applies cumulatively across the whole chain, not per
 * attempt.
 */
export async function dispatchWithFallback(
  spec: TaskSpec,
  router: Router,
  ctx: DispatchContext,
  telemetry: TelemetryStore,
  options: DispatchOptions = {},
): Promise<ResultEnvelope> {
  const chain = router.route(spec, options.routeOptions);
  const signal = options.signal ?? new AbortController().signal;

  if (chain.length === 0) {
    return {
      specId: spec.id,
      attempts: [],
      finalStatus: "failed",
      totalUsdSpent: 0,
      totalLatencyMs: 0,
      stopReason: "no providers survived routing — see Router.explain() for why",
    };
  }

  let remainingBudget = spec.budget?.maxUsd ?? Number.POSITIVE_INFINITY;
  const attempts: DispatchAttempt[] = [];
  let totalUsdSpent = 0;
  let totalLatencyMs = 0;
  let chosenAttemptIndex: number | undefined;
  let stopReason: string | undefined;

  for (const provider of chain) {
    const profile = provider.capabilities();
    const estimate = provider.estimate(spec);

    if (estimate.usd > remainingBudget) {
      stopReason = "budget exhausted partway through the fallback chain";
      break;
    }

    const startedAt = new Date();
    let tokenText = "";
    const artifacts: DispatchArtifact[] = [];
    let usage: DispatchUsage = { inputTokens: 0, outputTokens: 0 };
    let error: string | undefined;

    try {
      for await (const event of provider.dispatch(spec, ctx, signal)) {
        switch (event.type) {
          case "token":
            tokenText += event.text;
            break;
          case "artifact":
            artifacts.push({ name: event.name, mimeType: event.mimeType, content: event.content });
            break;
          case "usage":
            usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
            break;
          case "error":
            error = event.message;
            break;
          case "toolCall":
          case "done":
            break;
        }
      }
    } catch (err) {
      error = (err as Error).message;
    }

    const endedAt = new Date();
    const latencyMs = endedAt.getTime() - startedAt.getTime();
    const usdSpent = computeUsd(profile, usage);
    totalUsdSpent += usdSpent;
    totalLatencyMs += latencyMs;
    remainingBudget -= usdSpent;

    // "diff" output becomes the envelope's diff field, ready for
    // scratch-worktree verification below. "message" output has nowhere
    // else to go in the envelope shape, so it's recorded as an artifact
    // rather than silently dropped. "artifact" output relies entirely on
    // artifact-typed DispatchEvents the provider already emitted.
    const diff = spec.expects === "diff" && tokenText.length > 0 ? tokenText : undefined;
    if (spec.expects === "message" && tokenText.length > 0) {
      artifacts.push({ name: "response.md", mimeType: "text/markdown", content: tokenText });
    }

    const acceptance: AcceptanceResult = error
      ? { status: "failed", reason: error }
      : await runAcceptance(spec, ctx.workspaceRoot, diff, options.useScratchWorktree);

    const attempt: DispatchAttempt = {
      providerId: profile.providerId,
      modelId: profile.modelId,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      usdSpent,
      latencyMs,
      ...(diff !== undefined ? { diff } : {}),
      artifacts,
      usage,
      acceptance,
      ...(error !== undefined ? { error } : {}),
    };
    attempts.push(attempt);

    telemetry.recordAttempt({
      specId: spec.id,
      taskType: spec.taskType,
      providerId: profile.providerId,
      modelId: profile.modelId,
      usd: usdSpent,
      latencyMs,
      acceptance: acceptance.status,
      timestamp: endedAt.toISOString(),
    });

    if (acceptance.status === "passed" || acceptance.status === "skipped") {
      chosenAttemptIndex = attempts.length - 1;
      break;
    }
    // Anything else (failed) falls through to the next candidate in the chain.
  }

  if (chosenAttemptIndex === undefined && stopReason === undefined) {
    stopReason = "no candidate in the fallback chain passed acceptance";
  }

  const finalStatus: AcceptanceStatus =
    chosenAttemptIndex !== undefined ? attempts[chosenAttemptIndex]!.acceptance.status : "failed";

  return {
    specId: spec.id,
    attempts,
    finalStatus,
    ...(chosenAttemptIndex !== undefined ? { chosenAttemptIndex } : {}),
    totalUsdSpent,
    totalLatencyMs,
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}

function computeUsd(profile: CapabilityProfile, usage: DispatchUsage): number {
  return (
    (usage.inputTokens / 1_000_000) * profile.inputCostPerMTok +
    (usage.outputTokens / 1_000_000) * profile.outputCostPerMTok
  );
}

async function runAcceptance(
  spec: TaskSpec,
  workspaceRoot: string,
  diff: string | undefined,
  useScratchWorktree: boolean | undefined,
): Promise<AcceptanceResult> {
  const command = spec.acceptance;
  if (!command) {
    return skippedAcceptance();
  }

  // Scratch-worktree verification only makes sense when there's a diff to
  // apply first. For "artifact"/"message" outputs, v1 runs the acceptance
  // command directly against the real workspace — it can only observe
  // state a tool call already wrote to disk, not an in-memory artifact.
  // Known limitation; see README.
  if (diff === undefined || useScratchWorktree === false) {
    return runAcceptanceCommand(command, workspaceRoot);
  }

  try {
    return await withScratchWorktree(workspaceRoot, diff, (scratchDir) =>
      runAcceptanceCommand(command, scratchDir),
    );
  } catch (err) {
    if (err instanceof NotAGitRepoError) {
      return runAcceptanceCommand(command, workspaceRoot);
    }
    return {
      status: "failed",
      command,
      reason: `could not verify in a scratch worktree: ${(err as Error).message}`,
    };
  }
}
