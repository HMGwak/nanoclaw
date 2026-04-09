#!/usr/bin/env node
/**
 * Codex SDK bridge for nanoclaw.
 * Called from Python (codex_oauth.py) via subprocess.
 * Adapted from F_nextboat2_toxprofile_maker/runtime/codex_bridge.mjs
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function argValue(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

function hasArg(name) {
  return process.argv.slice(2).includes(name);
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function localPath(...parts) {
  return resolve(fileURLToPath(new URL(".", import.meta.url)), ...parts);
}

function repoPath(...parts) {
  return localPath("..", ...parts);
}

function codexPath() {
  const candidates = process.platform === "win32"
    ? [repoPath("node_modules", ".bin", "codex.cmd")]
    : [repoPath("node_modules", ".bin", "codex")];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Repository-local Codex CLI not found. Install dependencies so node_modules/.bin/codex exists."
  );
}

async function loadCodexSdkCtor() {
  const candidates = [
    repoPath("node_modules", "@openai", "codex-sdk", "dist", "index.js"),
    "@openai/codex-sdk",
  ];

  for (const candidate of candidates) {
    try {
      const module = await import(candidate);
      if (typeof module?.Codex === "function") {
        return module.Codex;
      }
    } catch {
      // try next candidate
    }
  }

  throw new Error("Codex SDK module was not found in this repository.");
}


async function readJsonStdin() {
  const raw = await new Promise((resolve) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => resolve(body));
  });

  const normalized = String(raw || "").replace(/^\uFEFF/, "").replace(/\u0000/g, "").trim();
  if (!normalized) return {};
  return JSON.parse(normalized);
}

async function probeRuntime() {
  let command;
  try {
    command = codexPath();
  } catch (error) {
    return { schema_version: "1", probe: "runtime", ok: false, code: "RUNTIME_NOT_FOUND", message: String(error), details: {} };
  }

  try {
    await loadCodexSdkCtor();
  } catch (error) {
    return { schema_version: "1", probe: "runtime", ok: false, code: "SDK_NOT_FOUND", message: String(error), details: { codex_path: command } };
  }

  return { schema_version: "1", probe: "runtime", ok: true, code: "RUNTIME_OK", message: "Codex runtime ready", details: { codex_path: command } };
}

async function probeExec() {
  let input;
  try {
    input = await readJsonStdin();
  } catch {
    return { schema_version: "1", probe: "exec", ok: false, code: "INVALID_INPUT", message: "stdin must be valid json", details: {} };
  }

  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : process.cwd();
  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;
  const reasoningEffort =
    typeof input.reasoning_effort === "string" && input.reasoning_effort.trim()
      ? input.reasoning_effort.trim()
      : undefined;
  const timeoutMs = Number.isFinite(input.timeout_ms) ? Number(input.timeout_ms) : 300000;
  const outputSchema =
    input.output_schema && typeof input.output_schema === "object" && !Array.isArray(input.output_schema)
      ? input.output_schema
      : undefined;

  if (!prompt) {
    return { schema_version: "1", probe: "exec", ok: false, code: "INVALID_INPUT", message: "prompt is required", details: {} };
  }

  const { spawn } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  let tmpDir;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "codex-bridge-"));
  } catch (e) {
    return { schema_version: "1", probe: "exec", ok: false, code: "EXEC_FAILED", message: `Failed to create temp dir: ${e}`, details: {} };
  }

  const outputFile = join(tmpDir, "output.txt");
  const schemaFile = outputSchema ? join(tmpDir, "schema.json") : null;

  try {
    if (schemaFile) {
      writeFileSync(schemaFile, JSON.stringify(outputSchema), "utf8");
    }

    const localCodexCliPath = codexPath();

    // Build args for `codex exec`
    // Use --dangerously-bypass-approvals-and-sandbox to avoid bwrap namespace
    // errors when spawned as subprocess (bwrap fails in Docker/subprocess contexts).
    const args = ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"];
    if (model) args.push("-m", model);
    if (reasoningEffort) args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
    if (schemaFile) args.push("--output-schema", schemaFile);
    args.push("--output-last-message", outputFile);
    args.push("--cd", cwd);
    args.push("-"); // read prompt from stdin

    const result = await new Promise((resolve) => {
      const child = spawn(localCodexCliPath, args, {
        env: process.env,
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      child.stdin.write(prompt, "utf8");
      child.stdin.end();

      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      // drain stdout to avoid blocking
      child.stdout.on("data", () => {});

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stderr, timedOut });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ exitCode: -1, stderr: String(err), timedOut: false });
      });
    });

    if (result.timedOut) {
      return { schema_version: "1", probe: "exec", ok: false, code: "TIMEOUT", message: "command timeout", details: {} };
    }

    const stderrLower = (result.stderr || "").toLowerCase();
    if (stderrLower.includes("not logged in") || stderrLower.includes("login required") || stderrLower.includes("authentication")) {
      return { schema_version: "1", probe: "exec", ok: false, code: "AUTH_REQUIRED", message: "Codex login required", details: { error: result.stderr } };
    }

    if (result.exitCode !== 0) {
      return { schema_version: "1", probe: "exec", ok: false, code: "EXEC_FAILED", message: result.stderr || `Exit code ${result.exitCode}`, details: { exit_code: result.exitCode, stderr: result.stderr } };
    }

    let finalResponse = "";
    try {
      finalResponse = readFileSync(outputFile, "utf8").trim();
    } catch {
      // output file might not exist if agent produced no output
    }

    return {
      schema_version: "1",
      probe: "exec",
      ok: true,
      code: "EXEC_OK",
      message: "ok",
      details: {
        final_response: finalResponse,
        codex_path: localCodexCliPath,
      },
    };
  } finally {
    try { unlinkSync(outputFile); } catch {}
    if (schemaFile) { try { unlinkSync(schemaFile); } catch {} }
    try { rmdirSync(tmpDir); } catch {}
  }
}

async function main() {
  const probe = argValue("--probe");
  let payload;

  if (probe === "runtime") {
    payload = await probeRuntime();
  } else if (probe === "exec") {
    payload = await probeExec();
  } else {
    payload = { schema_version: "1", probe: "unknown", ok: false, code: "INVALID_ARGS", message: "use --probe runtime|exec --json", details: {} };
  }

  if (hasArg("--json")) {
    printJson(payload);
  } else {
    process.stdout.write(`${payload.message}\n`);
  }

  process.exit(payload.ok ? 0 : 1);
}

main().catch((error) => {
  printJson({ schema_version: "1", probe: "internal", ok: false, code: "INTERNAL_ERROR", message: String(error), details: {} });
  process.exit(1);
});
