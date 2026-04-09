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

function resolveFinalResponse(turn) {
  if (typeof turn?.finalResponse === "string" && turn.finalResponse.trim()) {
    return turn.finalResponse;
  }
  if (Array.isArray(turn?.items)) {
    for (let i = turn.items.length - 1; i >= 0; i -= 1) {
      const item = turn.items[i];
      if (item?.type === "agent_message" && typeof item?.text === "string" && item.text.trim()) {
        return item.text;
      }
    }
  }
  return "";
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

  try {
    const localCodexCliPath = codexPath();
    const Codex = await loadCodexSdkCtor();
    const codex = new Codex({
      codexPathOverride: localCodexCliPath,
      env: process.env,
    });
    const thread = codex.startThread({
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { modelReasoningEffort: reasoningEffort } : {}),
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      sandboxMode: process.env.CODEX_SANDBOX_MODE || "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    });

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error("command timeout"));
    }, timeoutMs);

    let turn;
    try {
      turn = await thread.run(prompt, {
        signal: controller.signal,
        ...(outputSchema ? { outputSchema } : {}),
      });
    } finally {
      clearTimeout(timer);
    }

    return {
      schema_version: "1",
      probe: "exec",
      ok: true,
      code: "EXEC_OK",
      message: "ok",
      details: {
        final_response: resolveFinalResponse(turn),
        codex_path: localCodexCliPath,
      },
    };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    const lowered = message.toLowerCase();

    if (lowered.includes("timeout") || lowered.includes("aborted")) {
      return { schema_version: "1", probe: "exec", ok: false, code: "TIMEOUT", message: "command timeout", details: {} };
    }

    if (lowered.includes("not logged in") || lowered.includes("login required") || lowered.includes("authentication")) {
      return { schema_version: "1", probe: "exec", ok: false, code: "AUTH_REQUIRED", message: "Codex login required", details: { error: message } };
    }

    return { schema_version: "1", probe: "exec", ok: false, code: "EXEC_FAILED", message, details: { error: message } };
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
