import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GIT_ADD_ARGS,
  GIT_DIFF_ARGS,
  GIT_INIT_ARGS,
  GIT_LOG_ARGS,
  GIT_SHOW_ARGS,
  GIT_STATUS_ARGS,
  gitAdd,
  gitCommit,
  gitInit,
  gitLog,
  gitShow,
  git_diff,
  git_status,
  type CommandExecutor,
  type CommandExecutionResult,
  type PlannedCommand,
} from "../src/git/index.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout;
}

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-git-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "bridge-tests@example.invalid"]);
  await git(root, ["config", "user.name", "Bridge Tests"]);
  return root;
}

const successfulResult: CommandExecutionResult = {
  outcome: "completed",
  exitCode: 0,
  signal: null,
  durationMs: 1,
  stdout: "",
  stderr: "",
  stdoutBytes: 0,
  stderrBytes: 0,
  truncated: false,
};

test("gitInit initializes only the workspace root and supports Unicode/bracket filenames", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-git-init-"));
  try {
    const initialized = await gitInit({ workspaceRoot: root });
    assert.equal(initialized.operation, "init");
    assert.equal(initialized.outcome, "completed");
    assert.deepEqual(initialized.argv.slice(1), GIT_INIT_ARGS);
    assert.equal((await stat(path.join(root, ".git"))).isDirectory(), true);

    await git(root, ["config", "user.email", "bridge-tests@example.invalid"]);
    await git(root, ["config", "user.name", "Bridge Tests"]);
    await writeFile(path.join(root, "[ChatGPT] example.json"), "{}\n", "utf8");
    await writeFile(path.join(root, "中文文件名.md"), "中文\n", "utf8");
    const added = await gitAdd({ workspaceRoot: root, paths: ["[ChatGPT] example.json", "中文文件名.md"] });
    assert.equal(added.outcome, "completed");
    const committed = await gitCommit({ workspaceRoot: root, message: "special filenames" });
    assert.equal(committed.outcome, "completed");
    const committedNames = await gitOutput(root, ["-c", "core.quotepath=false", "show", "--name-only", "--format=", "HEAD"]);
    assert.match(committedNames, /\[ChatGPT\] example\.json/u);
    assert.match(committedNames, /中文文件名\.md/u);
    await assert.rejects(gitInit({ workspaceRoot: root }), /already exists|already a Git repository/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git write operations use write-specific limits", async () => {
  const root = await temporaryRepository();
  const calls: PlannedCommand[] = [];
  const executor: CommandExecutor = {
    async run(command) {
      calls.push(command);
      return successfulResult;
    },
  };
  try {
    await gitAdd({ workspaceRoot: root, executor });
    await gitCommit({ workspaceRoot: root, message: "limit check", executor });
    const add = calls.find((call) => call.kind === "git-add");
    const commit = calls.find((call) => call.kind === "git-commit");
    assert.ok(add);
    assert.ok(commit);
    assert.ok(add.timeoutMs > 10_000);
    assert.ok(commit.timeoutMs > 10_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gitCommit reconciles a commit that completed at the timeout boundary", async () => {
  const root = await temporaryRepository();
  try {
    await writeFile(path.join(root, "edge.txt"), "edge\n", "utf8");
    await git(root, ["add", "edge.txt"]);
    const runner = new (await import("../src/commands/command-runner.js")).ProcessRunner();
    const executor: CommandExecutor = {
      async run(command) {
        if (command.kind === "git-commit") {
          await execFileAsync(command.executable, [...command.args], { cwd: command.cwd, windowsHide: true, env: command.env });
          return { ...successfulResult, outcome: "timed-out", exitCode: null };
        }
        return runner.run(command);
      },
    };
    const result = await gitCommit({ workspaceRoot: root, message: "edge commit", executor });
    assert.equal(result.outcome, "completed");
    assert.equal(result.reconciliation?.status, "confirmed-completed");
    assert.equal(result.reconciliation?.originalOutcome, "timed-out");
    assert.match(await gitOutput(root, ["log", "-1", "--pretty=%s"]), /edge commit/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pre-existing index.lock is never deleted", async () => {
  const root = await temporaryRepository();
  try {
    const lockPath = path.join(root, ".git", "index.lock");
    await writeFile(lockPath, "external lock", "utf8");
    await assert.rejects(gitAdd({ workspaceRoot: root }), /index\.lock already exists/u);
    assert.equal((await stat(lockPath)).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git_status uses fixed shell-free argv and bounded output", async () => {
  const root = await temporaryRepository();
  const calls: PlannedCommand[] = [];
  const executor: CommandExecutor = {
    async run(command) {
      calls.push(command);
      return successfulResult;
    },
  };
  try {
    const result = await git_status({ workspaceRoot: root, executor });
    assert.equal(result.operation, "status");
    assert.deepEqual(calls[0]?.args, GIT_STATUS_ARGS);
    assert.equal(calls[0]?.shell, false);
    assert.equal(calls[0]?.env.GIT_OPTIONAL_LOCKS, "0");
    assert.equal(calls[0]?.env.GIT_TERMINAL_PROMPT, "0");
    assert.ok((calls[0]?.outputLimits.maxTotalBytes ?? 0) > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git_diff uses no external diff/textconv and accepts only safe paths", async () => {
  const root = await temporaryRepository();
  const calls: PlannedCommand[] = [];
  const executor: CommandExecutor = {
    async run(command) {
      calls.push(command);
      return successfulResult;
    },
  };
  try {
    await git_diff({ workspaceRoot: root, path: "src/example.ts", executor });
    assert.deepEqual(calls[0]?.args, [
      ...GIT_DIFF_ARGS.slice(0, GIT_DIFF_ARGS.indexOf("--") + 1),
      ":(literal)src/example.ts",
      ...GIT_DIFF_ARGS.slice(GIT_DIFF_ARGS.indexOf("--") + 2),
    ]);
    assert.ok(calls[0]?.args.includes("--no-ext-diff"));
    assert.ok(calls[0]?.args.includes("--no-textconv"));
    assert.equal(calls[0]?.shell, false);

    await assert.rejects(git_diff({ workspaceRoot: root, path: "../secret.txt", executor }), /relative|invalid/);
    await assert.rejects(git_diff({ workspaceRoot: root, path: "-c", executor }), /relative|invalid/);
    await assert.rejects(git_diff({ workspaceRoot: root, path: "src\u0000file", executor }), /relative|invalid/);
    await assert.doesNotReject(git_diff({ workspaceRoot: root, path: ":(icase).ENV", executor }), "literal pathspec wrapping neutralizes Git pathspec magic");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git_status and git_diff execute real read-only inspections", async () => {
  const root = await temporaryRepository();
  try {
    await writeFile(path.join(root, "tracked.txt"), "one\n", "utf8");
    await writeFile(path.join(root, "id_rsa"), "secret-one\n", "utf8");
    await writeFile(path.join(root, ".pypirc"), "secret-two\n", "utf8");
    await git(root, ["add", "tracked.txt", "id_rsa", ".pypirc"]);
    await git(root, ["commit", "-qm", "initial"]);
    await writeFile(path.join(root, "tracked.txt"), "two\n", "utf8");
    await writeFile(path.join(root, "id_rsa"), "leaked-private-key\n", "utf8");
    await writeFile(path.join(root, ".pypirc"), "leaked-credential\n", "utf8");

    const status = await git_status({ workspaceRoot: root });
    assert.equal(status.outcome, "completed");
    assert.match(status.stdout, /tracked\.txt/);
    assert.doesNotMatch(status.stdout, /id_rsa|\.pypirc/u);

    const diff = await git_diff({ workspaceRoot: root });
    assert.equal(diff.outcome, "completed");
    assert.match(diff.stdout, /-one/);
    assert.match(diff.stdout, /\+two/);
    assert.doesNotMatch(diff.stdout, /leaked-private-key|leaked-credential|id_rsa|\.pypirc/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gitAdd stages only safe paths and gitCommit commits staged changes without hooks", async () => {
  const root = await temporaryRepository();
  try {
    await writeFile(path.join(root, "tracked.txt"), "one\n", "utf8");
    await git(root, ["add", "tracked.txt"]);
    await git(root, ["commit", "-qm", "initial"]);
    await writeFile(path.join(root, "tracked.txt"), "two\n", "utf8");
    await writeFile(path.join(root, "other.txt"), "other\n", "utf8");
    await writeFile(path.join(root, ".env"), "SECRET=value\n", "utf8");

    const added = await gitAdd({ workspaceRoot: root, paths: ["tracked.txt"] });
    assert.equal(added.operation, "add");
    assert.equal(added.outcome, "completed");
    assert.equal((await gitOutput(root, ["diff", "--cached", "--name-only"])).trim(), "tracked.txt");
    await assert.rejects(gitAdd({ workspaceRoot: root, paths: [".env"] }), /blocked|relative/u);
    await assert.rejects(gitAdd({ workspaceRoot: root, paths: ["../escape"] }), /relative|invalid/u);

    const hooks = path.join(root, ".git", "hooks");
    await writeFile(path.join(hooks, "pre-commit"), process.platform === "win32" ? "@exit /b 1\r\n" : "#!/bin/sh\nexit 1\n", "utf8");
    if (process.platform !== "win32") await import("node:fs/promises").then(({ chmod }) => chmod(path.join(hooks, "pre-commit"), 0o755));

    const committed = await gitCommit({ workspaceRoot: root, message: "safe commit" });
    assert.equal(committed.operation, "commit");
    assert.equal(committed.outcome, "completed");
    assert.match(await gitOutput(root, ["log", "-1", "--pretty=%s"]), /safe commit/u);
    assert.equal((await gitOutput(root, ["status", "--short"])).includes("other.txt"), true);
    assert.equal((await gitOutput(root, ["status", "--short"])).includes(".env"), true);

    await git(root, ["add", "--", ".env"]);
    await assert.rejects(gitCommit({ workspaceRoot: root, message: "must reject secret" }), /blocked|relative/u);
    await assert.rejects(gitCommit({ workspaceRoot: root, message: "bad\nmessage" }), /message/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gitAdd uses fixed safe exclusions when staging all", async () => {
  const root = await temporaryRepository();
  const calls: PlannedCommand[] = [];
  const executor: CommandExecutor = {
    async run(command) {
      calls.push(command);
      return successfulResult;
    },
  };
  try {
    const result = await gitAdd({ workspaceRoot: root, executor });
    assert.equal(result.operation, "add");
    assert.deepEqual(calls[0]?.args, GIT_ADD_ARGS);
    assert.equal(calls[0]?.shell, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gitLog clamps count and keeps path input after a separator", async () => {
  const root = await temporaryRepository();
  const calls: PlannedCommand[] = [];
  const executor: CommandExecutor = {
    async run(command) {
      calls.push(command);
      return successfulResult;
    },
  };
  try {
    const result = await gitLog({ workspaceRoot: root, maxCount: 10_000, path: "src/example.ts", executor });
    assert.equal(result.operation, "log");
    assert.deepEqual(calls[0]?.args, [
      ...GIT_LOG_ARGS.slice(0, GIT_LOG_ARGS.indexOf("--max-count=20")),
      "--max-count=100",
      "--",
      ":(literal)src/example.ts",
      ...GIT_LOG_ARGS.slice(GIT_LOG_ARGS.indexOf("--") + 2),
    ]);
    assert.equal(calls[0]?.shell, false);
    assert.equal(calls[0]?.windowsHide, true);
    assert.ok(calls[0]?.args.includes("--no-patch"));
    assert.ok(calls[0]?.args.includes("--no-ext-diff"));
    assert.ok(calls[0]?.args.includes("--no-textconv"));

    await assert.rejects(gitLog({ workspaceRoot: root, maxCount: Number.NaN, executor }), /maxCount|finite/);
    await assert.rejects(gitLog({ workspaceRoot: root, path: "../secret.txt", executor }), /relative|invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gitShow accepts only narrow commit-ish forms and constructs safe revision file expressions", async () => {
  const root = await temporaryRepository();
  const calls: PlannedCommand[] = [];
  const executor: CommandExecutor = {
    async run(command) {
      calls.push(command);
      return successfulResult;
    },
  };
  try {
    const result = await gitShow({ workspaceRoot: root, commitish: "HEAD~12", path: "src/example.ts", executor });
    assert.equal(result.operation, "show");
    const args = calls[0]?.args ?? [];
    assert.equal(args.at(-1), "HEAD~12:src/example.ts");
    assert.equal(args.includes("--"), false);
    assert.equal(calls[0]?.shell, false);
    assert.equal(calls[0]?.windowsHide, true);
    assert.ok(args.includes("--no-pager"));
    assert.ok(args.includes("--no-optional-locks"));
    assert.ok(args.includes("--no-ext-diff"));
    assert.ok(args.includes("--no-textconv"));

    for (const commitish of ["-1", "--stat", "main", "HEAD^{tree}", "HEAD:id_rsa", "HEAD~1^2", "xyz-not-hex"]) {
      await assert.rejects(gitShow({ workspaceRoot: root, commitish, executor }), /commit-ish/);
    }
    await assert.rejects(gitShow({ workspaceRoot: root, path: "id_rsa", executor }), /blocked|relative/);
    await assert.doesNotReject(gitShow({ workspaceRoot: root, commitish: "deadbeef", executor }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gitLog and gitShow perform real bounded read-only inspections", async () => {
  const root = await temporaryRepository();
  try {
    await writeFile(path.join(root, "tracked.txt"), "one\n", "utf8");
    await writeFile(path.join(root, "id_rsa"), "secret-one\n", "utf8");
    await git(root, ["add", "tracked.txt", "id_rsa"]);
    await git(root, ["commit", "-qm", "initial commit"]);
    await writeFile(path.join(root, "tracked.txt"), "two\n", "utf8");
    await writeFile(path.join(root, "id_rsa"), "leaked-private-key\n", "utf8");
    await git(root, ["add", "tracked.txt", "id_rsa"]);
    await git(root, ["commit", "-qm", "second commit"]);

    const log = await gitLog({ workspaceRoot: root, maxCount: 2 });
    assert.equal(log.operation, "log");
    assert.equal(log.outcome, "completed");
    assert.match(log.stdout, /second commit/);
    assert.match(log.stdout, /initial commit/);
    assert.doesNotMatch(log.stdout, /id_rsa|leaked-private-key/u);

    const pathLog = await gitLog({ workspaceRoot: root, maxCount: 1, path: "tracked.txt" });
    assert.equal(pathLog.outcome, "completed");
    assert.match(pathLog.stdout, /second commit/);

    const show = await gitShow({ workspaceRoot: root, path: "tracked.txt" });
    assert.equal(show.operation, "show");
    assert.equal(show.outcome, "completed");
    assert.equal(show.stdout, "two\n");
    assert.doesNotMatch(show.stdout, /leaked-private-key|id_rsa/u);

    const fullShow = await gitShow({ workspaceRoot: root });
    assert.equal(fullShow.outcome, "completed");
    assert.doesNotMatch(fullShow.stdout, /leaked-private-key|id_rsa/u);

    const commit = (await gitOutput(root, ["rev-parse", "HEAD"])).trim();
    const fullHashShow = await gitShow({ workspaceRoot: root, commitish: commit, path: "tracked.txt" });
    assert.equal(fullHashShow.outcome, "completed");
    const shortHashShow = await gitShow({ workspaceRoot: root, commitish: commit.slice(0, 8), path: "tracked.txt" });
    assert.equal(shortHashShow.outcome, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git log/show fail safely outside a repository and bound output", async () => {
  const nonRepo = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-not-git-"));
  const root = await temporaryRepository();
  try {
    const log = await gitLog({ workspaceRoot: nonRepo });
    const show = await gitShow({ workspaceRoot: nonRepo });
    assert.equal(log.outcome, "failed");
    assert.equal(show.outcome, "failed");

    await writeFile(path.join(root, "large.txt"), "x".repeat(64 * 1024), "utf8");
    await git(root, ["add", "large.txt"]);
    await git(root, ["commit", "-qm", "large commit"]);
    const bounded = await gitShow({
      workspaceRoot: root,
      outputLimits: { maxStdoutBytes: 128, maxStderrBytes: 128, maxTotalBytes: 128 },
    });
    assert.equal(bounded.outcome, "output-limit");
    assert.equal(bounded.truncated, true);
    assert.ok(bounded.stdoutBytes <= 128);
  } finally {
    await rm(nonRepo, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
