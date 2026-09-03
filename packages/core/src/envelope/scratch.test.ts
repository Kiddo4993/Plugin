import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotAGitRepoError, withScratchWorktree } from "./scratch.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

describe("withScratchWorktree", () => {
  let repo: string;

  beforeEach(async () => {
    repo = mkdtempSync(path.join(tmpdir(), "thp-scratch-repo-"));
    await git(repo, ["init", "--quiet"]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await git(repo, ["config", "user.name", "Test"]);
    // Pin line-ending behavior so this test is deterministic on Windows,
    // where a global core.autocrlf=true would rewrite our \n fixtures to
    // \r\n on checkout regardless of what withScratchWorktree does.
    await git(repo, ["config", "core.autocrlf", "false"]);
    writeFileSync(path.join(repo, "file.txt"), "hello\n");
    await git(repo, ["add", "file.txt"]);
    await git(repo, ["commit", "--quiet", "-m", "initial"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("applies a diff in the scratch worktree without touching the real working tree", async () => {
    writeFileSync(path.join(repo, "file.txt"), "hello world\n");
    const diff = await git(repo, ["diff"]);
    await git(repo, ["checkout", "--quiet", "--", "file.txt"]);
    expect(readFileSync(path.join(repo, "file.txt"), "utf8")).toBe("hello\n");

    let observedContent = "";
    let scratchDirDuringCall = "";
    await withScratchWorktree(repo, diff, async (scratchDir) => {
      scratchDirDuringCall = scratchDir;
      observedContent = readFileSync(path.join(scratchDir, "file.txt"), "utf8");
    });

    expect(observedContent).toBe("hello world\n");
    // The real working tree was never touched.
    expect(readFileSync(path.join(repo, "file.txt"), "utf8")).toBe("hello\n");
    // The worktree is cleaned up afterward.
    expect(existsSync(scratchDirDuringCall)).toBe(false);
  });

  it("returns fn's result", async () => {
    const result = await withScratchWorktree(repo, undefined, async (scratchDir) => {
      return readFileSync(path.join(scratchDir, "file.txt"), "utf8");
    });
    expect(result).toBe("hello\n");
  });

  it("still cleans up the worktree when fn throws", async () => {
    let scratchDirDuringCall = "";
    await expect(
      withScratchWorktree(repo, undefined, async (scratchDir) => {
        scratchDirDuringCall = scratchDir;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(existsSync(scratchDirDuringCall)).toBe(false);
  });

  it("throws NotAGitRepoError for a workspace that isn't a git repo", async () => {
    const plain = mkdtempSync(path.join(tmpdir(), "thp-not-git-"));
    try {
      await expect(withScratchWorktree(plain, undefined, async () => "x")).rejects.toBeInstanceOf(
        NotAGitRepoError,
      );
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
