import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Execute the actual shell blocks consumers receive, rather than a copy of the
// publishing logic. actionlint validates the surrounding workflow structure.
function stepScript(file, name) {
  const lines = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8").split("\n");
  const step = lines.findIndex((line) => line.trim().replace(/^- /, "") === `name: ${name}`);
  assert.notEqual(step, -1, `Missing step ${name}`);
  const run = lines.findIndex((line, index) => index > step && line.trim() === "run: |");
  assert.notEqual(run, -1, `Missing script for ${name}`);
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

function fixture(t, scripts = {}) {
  const directory = mkdtempSync(join(tmpdir(), "npm-publish-workflow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "github-output");
  writeFileSync(output, "");
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name: "workflow-test-package",
    version: "1.2.3",
    scripts,
  }));
  const env = { ...process.env, CI: "true", GITHUB_OUTPUT: output, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  return { directory, output, env };
}

function runScript(file, name, context, extraEnv = {}) {
  return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", stepScript(file, name)], {
    cwd: context.directory,
    env: { ...context.env, ...extraEnv },
    encoding: "utf8",
  });
}

function succeeds(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
}

function git(context, cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=Workflow Test", "-c", "user.email=workflow-test@example.invalid", ...args], {
    cwd,
    env: context.env,
    encoding: "utf8",
  });
  succeeds(result);
  return result.stdout.trim();
}

function repository(t) {
  const context = fixture(t);
  const remote = join(context.directory, "remote.git");
  const writer = join(context.directory, "writer");
  const checkout = join(context.directory, "checkout");
  git(context, context.directory, "init", "--bare", "--initial-branch=main", remote);
  git(context, context.directory, "clone", remote, writer);
  writeFileSync(join(writer, "contents"), "tested\n");
  git(context, writer, "add", "contents");
  git(context, writer, "commit", "--quiet", "-m", "tested revision");
  git(context, writer, "push", "origin", "main");
  const sha = git(context, writer, "rev-parse", "HEAD");
  git(context, context.directory, "clone", remote, checkout);
  git(context, checkout, "checkout", "--detach", sha);
  return { ...context, directory: checkout, writer, sha };
}

function advanceMain(context) {
  writeFileSync(join(context.writer, "contents"), "newer\n");
  git(context, context.writer, "add", "contents");
  git(context, context.writer, "commit", "--quiet", "-m", "new main revision");
  git(context, context.writer, "push", "origin", "main");
}

test("accepts the CI commit when it is still main", (t) => {
  const context = repository(t);
  succeeds(runScript("publish.yml", "Verify the tested revision is still main", context, {
    TESTED_SHA: context.sha, CALLER_SHA: context.sha,
  }));
  assert.match(readFileSync(context.output, "utf8"), new RegExp(`tested_sha=${context.sha}`));
  succeeds(runScript("publish.yml", "Reconfirm the published revision", context, { TESTED_SHA: context.sha }));
});

test("rejects a tested commit different from the caller's commit", (t) => {
  const context = repository(t);
  const result = runScript("publish.yml", "Verify the tested revision is still main", context, {
    TESTED_SHA: context.sha, CALLER_SHA: "0".repeat(40),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must match the calling workflow/);
});

test("rejects a checkout different from the tested commit", (t) => {
  const context = repository(t);
  advanceMain(context);
  const newSha = git(context, context.writer, "rev-parse", "HEAD");
  const result = runScript("publish.yml", "Verify the tested revision is still main", context, {
    TESTED_SHA: newSha, CALLER_SHA: newSha,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no longer the tip of main/);
});

test("rejects an older CI run after main advances", (t) => {
  const context = repository(t);
  advanceMain(context);
  const result = runScript("publish.yml", "Verify the tested revision is still main", context, {
    TESTED_SHA: context.sha, CALLER_SHA: context.sha,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no longer the tip of main/);
});

test("rechecks main after dependency installation and preparation", (t) => {
  const context = repository(t);
  succeeds(runScript("publish.yml", "Verify the tested revision is still main", context, {
    TESTED_SHA: context.sha, CALLER_SHA: context.sha,
  }));
  advanceMain(context);
  const result = runScript("publish.yml", "Reconfirm the published revision", context, { TESTED_SHA: context.sha });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no longer the tip of main/);
});

test("a failed fetch prevents publishing", (t) => {
  const context = repository(t);
  git(context, context.directory, "remote", "set-url", "origin", join(context.writer, "missing.git"));
  assert.notEqual(runScript("publish.yml", "Reconfirm the published revision", context, { TESTED_SHA: context.sha }).status, 0);
});

for (const [label, scripts, legacy] of [
  ["prepublishOnly", { prepublishOnly: "node hook.cjs" }, ""],
  ["legacy prepublish", { prepublish: "node hook.cjs" }, "prepublish"],
  ["both scripts", { prepublishOnly: "node hook.cjs", prepublish: "node legacy.cjs" }, ""],
  ["no lifecycle scripts", {}, ""],
]) {
  test(`supports ${label}`, (t) => {
    const context = fixture(t, scripts);
    succeeds(runScript("publish.yml", "Read package version and lifecycle scripts", context));
    assert.equal(readFileSync(context.output, "utf8"), `version=1.2.3\nlegacy_script=${legacy}\n`);
  });
}

test("npm invokes prepublishOnly exactly once without the legacy step", (t) => {
  const context = fixture(t, { prepublishOnly: "node hook.cjs" });
  writeFileSync(join(context.directory, "hook.cjs"), 'require("node:fs").appendFileSync("hook-runs", "ran\\n");\n');
  succeeds(runScript("publish.yml", "Read package version and lifecycle scripts", context));
  assert.match(readFileSync(context.output, "utf8"), /legacy_script=\n/);
  succeeds(spawnSync("npm", ["publish", "--dry-run", "--offline", "--registry=http://127.0.0.1:9"], {
    cwd: context.directory,
    env: { ...context.env, npm_config_cache: join(context.directory, "npm-cache") },
    encoding: "utf8",
  }));
  assert.equal(readFileSync(join(context.directory, "hook-runs"), "utf8"), "ran\n");
});

test("legacy prepublish still runs for older packages", (t) => {
  const context = fixture(t, { prepublish: "node hook.cjs" });
  writeFileSync(join(context.directory, "hook.cjs"), 'require("node:fs").appendFileSync("hook-runs", "ran\\n");\n');
  succeeds(runScript("publish.yml", "Run legacy prepublish", context, { PACKAGE_MANAGER: "npm" }));
  assert.equal(readFileSync(join(context.directory, "hook-runs"), "utf8"), "ran\n");
});

test("failed prepublishOnly stops npm publishing", (t) => {
  const context = fixture(t, { prepublishOnly: "node -e 'process.exit(17)'" });
  const result = spawnSync("npm", ["publish", "--dry-run", "--offline", "--registry=http://127.0.0.1:9"], {
    cwd: context.directory,
    env: { ...context.env, npm_config_cache: join(context.directory, "npm-cache") },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /17/);
});

function registryFixture(t, stdout, stderr = "", status = 0) {
  const context = fixture(t);
  const bin = join(context.directory, "bin");
  mkdirSync(bin);
  const stdoutPath = join(context.directory, "registry-stdout");
  const stderrPath = join(context.directory, "registry-stderr");
  writeFileSync(stdoutPath, stdout);
  writeFileSync(stderrPath, stderr);
  writeFileSync(join(bin, "npm"), '#!/bin/sh\ncat "$FAKE_STDOUT"\ncat "$FAKE_STDERR" >&2\nexit "$FAKE_STATUS"\n', { mode: 0o755 });
  context.env = {
    ...context.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STDOUT: stdoutPath,
    FAKE_STDERR: stderrPath, FAKE_STATUS: String(status), PACKAGE_NAME: "", REGISTRY_URL: "https://registry.npmjs.org",
  };
  return context;
}

for (const [label, stdout, stderr, status, expected] of [
  ["published version", '["1.2.3"]', "", 0, false],
  ["new version", '["1.2.2"]', "", 0, true],
  ["single published version", '"1.2.3"', "", 0, false],
  ["first publication", "", "npm error code E404", 1, true],
]) {
  test(`version check handles ${label}`, (t) => {
    const context = registryFixture(t, stdout, stderr, status);
    succeeds(runScript("check.yml", "Check whether the package version is published", context));
    assert.match(readFileSync(context.output, "utf8"), new RegExp(`should_publish=${expected}`));
  });
}

for (const [label, stdout, stderr, status] of [
  ["registry outage", "", "npm error code E503", 1],
  ["authentication failure", "", "npm error code E401", 1],
  ["invalid registry response", "invalid-json", "", 0],
]) {
  test(`version check fails closed on ${label}`, (t) => {
    const context = registryFixture(t, stdout, stderr, status);
    assert.notEqual(runScript("check.yml", "Check whether the package version is published", context).status, 0);
    assert.doesNotMatch(readFileSync(context.output, "utf8"), /should_publish=true/);
  });
}
