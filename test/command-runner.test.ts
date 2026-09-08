import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CommandPlanner,
  CommandPolicyError,
  CommandRequestValidationError,
  ControlledCommandRunner,
  createSanitizedChildEnv,
  discoverPackageManager,
  parseExecCommandRequest,
  ProcessRunner,
  RuntimeNotFoundError,
  resolveCommandCwd,
  type PlannedCommand,
} from "../src/commands/index.js";

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function nodeCommand(script: string, cwd: string, limits: Partial<PlannedCommand> = {}): PlannedCommand {
  return {
    executable: process.execPath,
    args: ["-e", script],
    cwd,
    env: createSanitizedChildEnv(),
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    timeoutMs: 2_000,
    outputLimits: {
      maxStdoutBytes: 256 * 1024,
      maxStderrBytes: 256 * 1024,
      maxTotalBytes: 512 * 1024,
    },
    killGraceMs: 100,
    kind: "test",
    ...limits,
  };
}

test("exec command schema rejects arbitrary command, args, and env fields", () => {
  assert.throws(
    () => parseExecCommandRequest({ kind: "test", command: "echo unsafe" }),
    (error: unknown) => error instanceof CommandRequestValidationError,
  );
  assert.throws(
    () => parseExecCommandRequest({ kind: "package-script", name: "test; echo unsafe" }),
    (error: unknown) => error instanceof CommandRequestValidationError,
  );
  assert.throws(
    () => parseExecCommandRequest({ kind: "build", env: { NODE_OPTIONS: "--require evil" } }),
    (error: unknown) => error instanceof CommandRequestValidationError,
  );
  assert.throws(
    () => parseExecCommandRequest({ kind: "unknown" }),
    (error: unknown) => error instanceof CommandRequestValidationError,
  );
});

test("planner creates shell-free allowlisted package-script commands", async () => {
  const root = await temporaryDirectory("mcp-bridge-command-planner-");
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node test.js", build: "node build.js" } }),
      "utf8",
    );
    const planner = new CommandPlanner({ limits: { test: { timeoutMs: 500 } } });
    const packageManager = { kind: "npm" as const, executable: process.execPath };
    const plan = await planner.plan({ kind: "test" }, { workspaceRoot: root, packageManager });

    assert.equal(plan.shell, false);
    assert.equal(plan.cwd, root);
    assert.equal(plan.timeoutMs, 500);
    assert.deepEqual(plan.args, ["run", "test"]);
    assert.equal(plan.env.NODE_OPTIONS, undefined);
    assert.equal(plan.env.NODE_PATH, undefined);
    assert.equal(plan.env.CONTROL_PLANE_API_KEY, undefined);
    assert.equal(plan.env.OPENAI_API_KEY, undefined);
    assert.ok((plan.env.Path ?? plan.env.PATH ?? "").includes(path.dirname(process.execPath)));

    const nested = path.join(root, "nested");
    await mkdir(nested);
    await writeFile(path.join(nested, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }), "utf8");
    const nestedPlan = await planner.plan({ kind: "test", cwd: "nested" }, { workspaceRoot: root, packageManager });
    assert.equal(nestedPlan.cwd, nested);
    await assert.rejects(
      planner.plan({ kind: "test", cwd: "../outside" }, { workspaceRoot: root, packageManager }),
      (error: unknown) => error instanceof CommandPolicyError,
    );

    await assert.rejects(
      planner.plan({ kind: "package-script", name: "build" }, { workspaceRoot: root, allowedPackageScripts: ["test"], packageManager }),
      (error: unknown) => error instanceof CommandPolicyError && /not allowed/.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("controlled runner executes only the planned package-script argv", async () => {
  const root = await temporaryDirectory("mcp-bridge-package-script-");
  try {
    const manager = path.join(root, "fake-package-manager.mjs");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "ignored by fake manager" } }), "utf8");
    await writeFile(
      manager,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
      "utf8",
    );

    const result = await new ControlledCommandRunner().run(
      { kind: "test" },
      {
        workspaceRoot: root,
        packageManager: { kind: "npm", executable: manager, nodeExecutable: process.execPath },
      },
    );

    assert.equal(result.outcome, "completed");
    assert.equal(result.stdout, '["run","test"]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default package manager resolves to a safe absolute executable and runs a real script", async () => {
  const root = await temporaryDirectory("mcp-bridge-real-package-manager-");
  try {
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node -e \"process.stdout.write('package-ok')\"" } }),
      "utf8",
    );
    const result = await new ControlledCommandRunner().run({ kind: "test" }, { workspaceRoot: root });
    assert.equal(result.outcome, "completed");
    assert.match(result.stdout, /package-ok/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package.json packageManager takes precedence over lockfiles", async () => {
  const root = await temporaryDirectory("mcp-bridge-package-manager-discovery-");
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ packageManager: "npm@10.9.0", scripts: { test: "node -e \"\"" } }),
      "utf8",
    );
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");
    assert.equal(await discoverPackageManager(root), "npm");

    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"\"" } }), "utf8");
    await rm(path.join(root, "pnpm-lock.yaml"));
    assert.equal(await discoverPackageManager(root), "npm");
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    assert.equal(await discoverPackageManager(root), "pnpm");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing configured package manager reports stable runtime error", async () => {
  const root = await temporaryDirectory("mcp-bridge-runtime-missing-");
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"\"" } }), "utf8");
    const missing = path.join(root, "missing-pnpm.exe");
    await assert.rejects(
      new ControlledCommandRunner().run(
        { kind: "test" },
        { workspaceRoot: root, packageManager: { kind: "pnpm", executable: missing, nodeExecutable: process.execPath } },
      ),
      (error: unknown) => error instanceof RuntimeNotFoundError && error.code === "RUNTIME_NOT_FOUND" && error.runtime === "pnpm",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows package manager wrappers resolve to a fixed Node script without shell", { skip: process.platform !== "win32" }, async () => {
  const root = await temporaryDirectory("mcp-bridge-windows-wrapper-");
  try {
    const script = path.join(root, "node_modules", "pnpm", "bin", "pnpm.mjs");
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "ignored" } }), "utf8");
    await writeFile(
      script,
      "const args = process.argv.slice(2); process.stdout.write(args.includes('--version') ? '9.0.0' : JSON.stringify(args));\n",
      "utf8",
    );
    const wrapper = path.join(root, "pnpm.cmd");
    await writeFile(wrapper, "@echo off\nnode \"%~dp0node_modules\\pnpm\\bin\\pnpm.mjs\" %*\n", "utf8");

    const plan = await new CommandPlanner().plan(
      { kind: "test" },
      { workspaceRoot: root, packageManager: { kind: "pnpm", executable: wrapper, nodeExecutable: process.execPath } },
    );
    assert.equal(plan.shell, false);
    assert.equal(plan.executable, process.execPath);
    assert.deepEqual(plan.args, [script, "run", "test"]);
    const result = await new ProcessRunner().run(plan);
    assert.equal(result.outcome, "completed");
    assert.equal(result.stdout, '["run","test"]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cwd resolves only inside the canonical workspace and rejects escapes", async () => {
  const parent = await temporaryDirectory("mcp-bridge-cwd-");
  const root = path.join(parent, "workspace");
  const nested = path.join(root, "nested");
  try {
    await mkdir(nested, { recursive: true });
    assert.equal(await resolveCommandCwd(root), root);
    assert.equal(await resolveCommandCwd(root, "nested"), nested);

    await assert.rejects(resolveCommandCwd(root, "../outside"), CommandPolicyError);
    await assert.rejects(resolveCommandCwd(root, "nested/../."), /traversal|ambiguous/u);
    await assert.rejects(resolveCommandCwd(root, "nested//."), /traversal|ambiguous/u);
    await assert.rejects(resolveCommandCwd(root, path.join("..", path.basename(parent))), CommandPolicyError);
    await assert.rejects(resolveCommandCwd(root, path.resolve(parent, "outside")), CommandPolicyError);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("process runner bounds output and terminates a noisy child", async () => {
  const root = await temporaryDirectory("mcp-bridge-output-");
  try {
    const command = nodeCommand(
      "process.stdout.write('x'.repeat(1024 * 1024)); setInterval(() => {}, 1000);",
      root,
      {
        timeoutMs: 2_000,
        outputLimits: { maxStdoutBytes: 1024, maxStderrBytes: 1024, maxTotalBytes: 2048 },
        killGraceMs: 100,
      },
    );
    const result = await new ProcessRunner().run(command);

    assert.equal(result.outcome, "output-limit");
    assert.ok(result.stdoutBytes <= 1024);
    assert.ok(result.stdout.length > 0);
    assert.equal(result.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timeout terminates the process group including a grandchild", async () => {
  const root = await temporaryDirectory("mcp-bridge-timeout-");
  const marker = path.join(root, "grandchild-alive.txt");
  try {
    const childScript = [
      "const fs = require('node:fs');",
      "setTimeout(() => fs.writeFileSync(process.argv[1], 'alive'), 700);",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}, process.argv[1]], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const command = nodeCommand(parentScript, root, { args: ["-e", parentScript, marker], timeoutMs: 100, killGraceMs: 100 });
    const result = await new ProcessRunner().run(command);

    assert.equal(result.outcome, "timed-out");
    await new Promise((resolve) => setTimeout(resolve, 900));
    await assert.rejects(import("node:fs/promises").then(({ access }) => access(marker)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
