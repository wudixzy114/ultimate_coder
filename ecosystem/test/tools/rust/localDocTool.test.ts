import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { runRustLocalDoc } from "../../../src/tools/rust/localDocTool.js";

const execFileAsync = promisify(execFile);
const TEMP_PREFIX = "ultimate-coder-rustlocaldoc-test-";

test("std docs work outside a Cargo project", async () => {
  await using workspace = await tempWorkspace();

  const output = await runRustLocalDoc(
    {
      action: "search",
      query: "Vec",
      crate: "std",
      limit: 3,
      autoGenerate: false,
    },
    { cwd: workspace.path },
  );

  assert.match(output, /Local Rust documentation matches for "Vec"/);
  assert.match(output, /vec::Vec \(struct\)/);
  assert.doesNotMatch(output, /No Cargo\.toml found/);
});

test("std member lookup returns the precise method section", async () => {
  await using workspace = await tempWorkspace();

  const output = await runRustLocalDoc(
    { action: "item", query: "Vec::retain", crate: "std", maxChars: 2_500 },
    { cwd: workspace.path },
  );

  assert.match(output, /Best local match: vec::Vec \(struct\)/);
  assert.match(output, /# vec::Vec::retain/);
  assert.match(output, /pub fn retain/);
  assert.match(output, /Retains only the elements specified by the predicate/);
  assert.match(output, /vec\.retain\(\|&x\| x % 2 == 0\)/);
});

test("third-party docs fail clearly when there is no Cargo project", async () => {
  await using workspace = await tempWorkspace();

  const output = await runRustLocalDoc(
    { action: "item", query: "serde::Serialize", autoGenerate: true },
    { cwd: workspace.path },
  );

  assert.match(output, /No local Rust documentation roots are available/);
  assert.match(output, /No Cargo\.toml found/);
});

test("new Cargo.toml dependency without generated docs is reported when autoGenerate is false", async () => {
  await using workspace = await tempRustProject({
    dependencies: `serde = { version = "1", features = ["derive"] }`,
  });

  const output = await runRustLocalDoc(
    { action: "item", query: "serde::Serialize", autoGenerate: false },
    { cwd: workspace.path },
  );

  assert.match(output, /No local Rust documentation roots are available/);
  assert.match(output, /target\/doc missing|target\\doc missing/);
  assert.equal(await exists(path.join(workspace.path, "target", "doc")), false);
});

test("new Cargo.toml dependency is documented automatically and then searchable", async () => {
  await using workspace = await tempRustProject({
    dependencies: `serde = { version = "1", features = ["derive"] }`,
  });

  const first = await runRustLocalDoc(
    {
      action: "item",
      query: "serde::Serialize",
      autoGenerate: true,
      maxChars: 2_500,
    },
    { cwd: workspace.path },
  );

  assert.match(
    first,
    /target\/doc missing; ran cargo doc --quiet|target\\doc missing; ran cargo doc --quiet/,
  );
  assert.match(first, /Best local match: Serialize \(trait\)/);
  assert.match(first, /pub trait Serialize/);
  assert.match(first, /fn serialize/);
  assert.equal(
    await exists(
      path.join(
        workspace.path,
        "target",
        "doc",
        "serde",
        "trait.Serialize.html",
      ),
    ),
    true,
  );

  const second = await runRustLocalDoc(
    {
      action: "item",
      query: "Serialize",
      crate: "serde",
      autoGenerate: false,
      maxChars: 1_500,
    },
    { cwd: workspace.path },
  );

  assert.match(second, /Best local match: Serialize \(trait\)/);
  assert.doesNotMatch(second, /ran cargo doc --quiet/);
});

test("filtered std output keeps key facts while saving substantial token budget", async (t) => {
  await using workspace = await tempWorkspace();

  const output = await runRustLocalDoc(
    { action: "item", query: "Vec::retain", crate: "std", maxChars: 2_500 },
    { cwd: workspace.path },
  );

  const file = extractFile(output);
  const rawHtml = await readFile(file, "utf8");
  const metrics = reductionMetrics(rawHtml, output);

  assert.match(output, /pub fn retain/);
  assert.match(output, /Retains only the elements specified by the predicate/);
  assert.match(output, /§ Examples/);
  assert.ok(
    metrics.outputChars <= 3_500,
    `filtered output should stay compact, got ${metrics.outputChars} chars`,
  );
  assert.ok(
    metrics.savedPercent >= 95,
    `expected at least 95% char/token savings, got ${metrics.savedPercent}%`,
  );

  t.diagnostic(JSON.stringify(metrics));
});

test("filtered dependency output keeps signature and summary while saving token budget", async (t) => {
  await using workspace = await tempRustProject({
    dependencies: `serde = { version = "1", features = ["derive"] }`,
  });

  const output = await runRustLocalDoc(
    { action: "item", query: "serde::Serialize", maxChars: 2_500 },
    { cwd: workspace.path },
  );

  const file = extractFile(output);
  const rawHtml = await readFile(file, "utf8");
  const metrics = reductionMetrics(rawHtml, output);

  assert.match(output, /pub trait Serialize/);
  assert.match(output, /A data structure that can be serialized/);
  assert.match(output, /fn serialize/);
  assert.ok(
    metrics.outputChars <= 4_000,
    `filtered output should stay compact, got ${metrics.outputChars} chars`,
  );
  assert.ok(
    metrics.savedPercent >= 80,
    `expected at least 80% char/token savings, got ${metrics.savedPercent}%`,
  );

  t.diagnostic(JSON.stringify(metrics));
});

async function tempWorkspace(): Promise<AsyncDisposable & { path: string }> {
  const root = path.join(
    tmpdir(),
    `${TEMP_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(root, { recursive: true });
  return {
    path: root,
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function tempRustProject(options: {
  dependencies: string;
}): Promise<AsyncDisposable & { path: string }> {
  const workspace = await tempWorkspace();
  await execFileAsync("cargo", ["init", "--lib", "--quiet"], {
    cwd: workspace.path,
    windowsHide: true,
    timeout: 60_000,
  });

  const manifest = path.join(workspace.path, "Cargo.toml");
  const current = await readFile(manifest, "utf8");
  await writeFile(
    manifest,
    current.replace(
      "[dependencies]",
      `[dependencies]\n${options.dependencies}`,
    ),
    "utf8",
  );
  return workspace;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function extractFile(output: string): string {
  const match = output.match(/^File:\s*(.+)$/m);
  assert.ok(match?.[1], `output did not include File line:\n${output}`);
  return match[1].trim();
}

function reductionMetrics(rawHtml: string, filtered: string) {
  const rawChars = rawHtml.length;
  const outputChars = filtered.length;
  const rawEstimatedTokens = Math.ceil(rawChars / 4);
  const outputEstimatedTokens = Math.ceil(outputChars / 4);
  const savedPercent = Number(
    (((rawChars - outputChars) / rawChars) * 100).toFixed(2),
  );

  return {
    rawChars,
    outputChars,
    rawEstimatedTokens,
    outputEstimatedTokens,
    savedEstimatedTokens: rawEstimatedTokens - outputEstimatedTokens,
    savedPercent,
  };
}
