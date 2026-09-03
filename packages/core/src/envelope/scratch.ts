import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export class NotAGitRepoError extends Error {
  constructor(workspaceRoot: string) {
    super(
      `${workspaceRoot} is not inside a git working tree — scratch-worktree verification requires git.`,
    );
    this.name = "NotAGitRepoError";
  }
}

export class ApplyDiffError extends Error {
  constructor(cause: string) {
    super(`failed to apply diff in scratch worktree: ${cause}`);
    this.name = "ApplyDiffError";
  }
}

async function isGitRepo(workspaceRoot: string): Promise<boolean> {
  try {
    const stdout = await run("git", ["rev-parse", "--is-inside-work-tree"], workspaceRoot);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.toString() || err.message));
      } else {
        resolve(stdout.toString());
      }
    });
  });
}

/**
 * Creates a temporary git worktree checked out from the workspace's current
 * HEAD, applies `diff` inside it (when given), runs `fn` with the
 * worktree's path, and always removes the worktree afterward — whether or
 * not `fn` throws. This is how a provider's diff gets verified before it
 * ever touches the real working tree. docs/DESIGN.md risk #3.
 */
export async function withScratchWorktree<T>(
  workspaceRoot: string,
  diff: string | undefined,
  fn: (scratchDir: string) => Promise<T>,
): Promise<T> {
  if (!(await isGitRepo(workspaceRoot))) {
    throw new NotAGitRepoError(workspaceRoot);
  }

  const scratchDir = await mkdtemp(path.join(tmpdir(), "thp-scratch-"));
  // `git worktree add` refuses a non-empty target directory — mkdtemp just
  // created one, so remove it and let git create the directory itself.
  await rm(scratchDir, { recursive: true, force: true });

  await run("git", ["worktree", "add", "--detach", "--quiet", scratchDir, "HEAD"], workspaceRoot);

  try {
    if (diff && diff.trim().length > 0) {
      await applyDiff(scratchDir, diff);
    }
    return await fn(scratchDir);
  } finally {
    try {
      await run("git", ["worktree", "remove", "--force", scratchDir], workspaceRoot);
    } catch {
      // best-effort — an already-gone or locked worktree shouldn't fail the caller
    }
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

function applyDiff(scratchDir: string, diff: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["apply", "--whitespace=nowarn", "-"],
      { cwd: scratchDir },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new ApplyDiffError(stderr.toString() || err.message));
        } else {
          resolve();
        }
      },
    );
    child.stdin?.write(diff);
    child.stdin?.end();
  });
}
