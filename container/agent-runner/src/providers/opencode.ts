/**
 * OpenCode Provider (Refactored)
 *
 * Uses OpenCode CLI `run` command instead of the limited SDK API.
 * This gives full access to OpenCode's built-in tools (bash, read, write,
 * edit, grep, glob, webfetch, websearch, etc.), MCP servers, and custom tools.
 *
 * Architecture:
 *   1. Generate opencode.jsonc config with model, MCP servers, tool permissions
 *   2. Copy custom tools to .opencode/tools/ using the current OpenCode plugin API
 *   3. Run `opencode run --format json "prompt"` as a subprocess
 *   4. Parse JSON event stream for assistant messages
 *
 * Env vars:
 *   OPENCODE_API_KEY   — API key for the model provider
 *   OPENCODE_MODEL     — Model identifier (e.g. "opencode-go/kimi-k2.5")
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import {
  buildInstructionSections,
  materializeInstructionFiles,
} from '../agent-instructions.js';
import {
  AgentProvider,
  AgentTurnContext,
  AgentTurnResult,
} from '../types.js';

const DEFAULT_OPENCODE_MODEL = 'opencode-go/kimi-k2.5';
const OPENCODE_TIMEOUT_MS = 300_000;
const MAX_OUTPUT = 200_000;
const WORK_DIR = '/workspace/group';
const CONFIG_DIR = '/workspace/group';

interface CommandCaptureOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxBuffer: number;
  log: (message: string) => void;
}

interface CommandCaptureResult {
  stdout: string;
  stderr: string;
}

function appendChunk(
  current: string,
  chunk: string,
  limit: number,
): { value: string; truncated: boolean } {
  if (current.length >= limit) {
    return { value: current, truncated: true };
  }
  const remaining = limit - current.length;
  if (chunk.length > remaining) {
    return {
      value: current + chunk.slice(0, remaining),
      truncated: true,
    };
  }
  return { value: current + chunk, truncated: false };
}

export async function runCommandWithClosedStdin(
  command: string,
  args: string[],
  options: CommandCaptureOptions,
): Promise<CommandCaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      fn();
    };

    const killTimer = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGKILL');
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      options.log(
        `OpenCode process timed out after ${options.timeoutMs}ms, terminating`,
      );
      child.kill('SIGTERM');
      setTimeout(killTimer, 5000).unref();
    }, options.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      const appended = appendChunk(stdout, chunk, options.maxBuffer);
      stdout = appended.value;
      if (appended.truncated && !stdoutTruncated) {
        stdoutTruncated = true;
        options.log(`OpenCode stdout truncated at ${options.maxBuffer} chars`);
      }
    });

    child.stderr.on('data', (chunk: string) => {
      const appended = appendChunk(stderr, chunk, options.maxBuffer);
      stderr = appended.value;
      if (appended.truncated && !stderrTruncated) {
        stderrTruncated = true;
        options.log(`OpenCode stderr truncated at ${options.maxBuffer} chars`);
      }
    });

    child.on('error', (err) => {
      finish(() => reject(err));
    });

    child.on('close', (code, signal) => {
      const detail = stderr.trim() || stdout.trim();
      if (timedOut) {
        finish(() =>
          reject(
            new Error(
              `Command timed out after ${options.timeoutMs}ms${
                detail ? `: ${detail.slice(0, 500)}` : ''
              }`,
            ),
          ),
        );
        return;
      }

      if (code !== 0) {
        finish(() =>
          reject(
            new Error(
              `Command failed${
                code !== null ? ` with code ${code}` : ''
              }${signal ? ` (${signal})` : ''}${
                detail ? `: ${detail.slice(0, 500)}` : ''
              }`,
            ),
          ),
        );
        return;
      }

      finish(() => resolve({ stdout, stderr }));
    });

    child.stdin.end();
  });
}

/**
 * Write opencode.jsonc config for this session.
 * Configures model, provider, tool permissions, and MCP servers.
 */
function writeConfig(
  model: string,
  ctx: AgentTurnContext,
): void {
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    model,
    // Tool permissions — all enabled, no prompting
    tools: {
      bash: true,
      read: true,
      write: true,
      edit: true,
      grep: true,
      glob: true,
      list: true,
      webfetch: true,
      websearch: true,
      patch: true,
      todowrite: true,
    },
    // No MCP — nanoclaw IPC tools are installed as native custom tools
    // to avoid MCP server hang issues inside the opencode subprocess.
    instructions: [] as string[],
  };

  const instructionSections = buildInstructionSections({
    containerInput: ctx.containerInput,
    defaultPrompt:
      'You are an AI assistant. Use shell for local commands, and for URL retrieval use cloudflare_fetch first when available, then agent-browser for interactive browsing, and Playwright only as a heavier fallback.',
  });
  const instructionDir = path.join(CONFIG_DIR, '.opencode', 'instructions');
  (config.instructions as string[]).push(
    ...materializeInstructionFiles(instructionSections, instructionDir),
  );

  const configPath = path.join(CONFIG_DIR, 'opencode.jsonc');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  ctx.log(`OpenCode config written to ${configPath}`);
}

/**
 * Install custom tools for agent-browser and playwright.
 * Tools are TypeScript files placed in .opencode/tools/.
 */
export function buildAgentBrowserToolSource(): string {
  return `
import { tool } from "@opencode-ai/plugin";
import { execSync } from "child_process";

const TIMEOUT = 30000;
const MAX_BUFFER = 100000;
const quote = (value) => JSON.stringify(String(value));

const run = (args) => {
  try {
    return execSync(\`agent-browser \${args}\`, { timeout: TIMEOUT, maxBuffer: MAX_BUFFER }).toString().trim();
  } catch (e) { return \`Error: \${e.message}\`; }
};

export const open = tool({
  description: "Open a URL in the browser and return accessibility snapshot with interactive element refs (@e1, @e2...). Token-efficient. Use for most browsing.",
  args: { url: tool.schema.string().describe("URL to open") },
  async execute(args) {
    run(\`open \${quote(args.url)}\`);
    run("wait --load networkidle");
    const snapshot = run("snapshot -i");
    const title = run("get title");
    const url = run("get url");
    return \`Page: \${title}\\nURL: \${url}\\n\\nInteractive elements:\\n\${snapshot}\`;
  },
});

export const click = tool({
  description: "Click an element by ref (e.g. @e1) and return updated snapshot.",
  args: { ref: tool.schema.string().describe("Element ref like @e1") },
  async execute(args) {
    run(\`click \${quote(args.ref)}\`);
    const snapshot = run("snapshot -i");
    return snapshot;
  },
});

export const fill = tool({
  description: "Fill a form field by ref with text.",
  args: {
    ref: tool.schema.string().describe("Element ref like @e1"),
    text: tool.schema.string().describe("Text to fill"),
  },
  async execute(args) {
    run(\`fill \${quote(args.ref)} \${quote(args.text)}\`);
    const snapshot = run("snapshot -i");
    return snapshot;
  },
});

export const select = tool({
  description: "Select a dropdown option by ref.",
  args: {
    ref: tool.schema.string().describe("Element ref like @e1"),
    option: tool.schema.string().describe("Option to select"),
  },
  async execute(args) {
    run(\`select \${quote(args.ref)} \${quote(args.option)}\`);
    const snapshot = run("snapshot -i");
    return snapshot;
  },
});

export const snapshot = tool({
  description: "Get current page accessibility snapshot without performing any action.",
  args: {},
  async execute() {
    const snap = run("snapshot -i");
    const title = run("get title");
    const url = run("get url");
    return \`Page: \${title}\\nURL: \${url}\\n\\n\${snap}\`;
  },
});

export const getText = tool({
  description: "Extract text content from a specific element or the full page.",
  args: {
    ref: tool.schema.string().optional().describe("Element ref (omit for full page)"),
  },
  async execute(args) {
    return args.ref ? run(\`get text \${quote(args.ref)}\`) : run("get text");
  },
});

export const press = tool({
  description: "Press a keyboard key (e.g. Enter, Tab, Escape).",
  args: { key: tool.schema.string().describe("Key to press") },
  async execute(args) {
    run(\`press \${quote(args.key)}\`);
    const snapshot = run("snapshot -i");
    return snapshot;
  },
});

export const close = tool({
  description: "Close the browser session.",
  args: {},
  async execute() {
    return run("close --all");
  },
});
`;
}

export function buildPlaywrightToolSource(): string {
  return `
import { tool } from "@opencode-ai/plugin";
import { execSync } from "child_process";
import fs from "fs";

const CHROMIUM = process.env.AGENT_BROWSER_EXECUTABLE_PATH || "/usr/bin/chromium";
const TIMEOUT = 30000;
const MAX_OUT = 120000;

const runPw = (scriptBody) => {
  const script = \`
const { chromium } = require('/app/node_modules/playwright-core');
(async () => {
const browser = await chromium.launch({
  executablePath: '\${CHROMIUM}',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  \${scriptBody}
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err.message }));
} finally {
  await browser.close();
}
})();
\`;
  fs.writeFileSync('/tmp/pw-run.cjs', script);
  try {
    return execSync('node /tmp/pw-run.cjs', { timeout: TIMEOUT, maxBuffer: MAX_OUT * 2 }).toString().trim();
  } catch (e) { return JSON.stringify({ ok: false, error: e.message }); }
};

export const open = tool({
  description: "Open URL with Playwright and extract full page text. Heavier than agent-browser but gives full content.",
  args: { url: tool.schema.string().describe("URL to open") },
  async execute(args) {
    const safeUrl = args.url.replace(/'/g, "\\\\'");
    return runPw(\`
      await page.goto('\${safeUrl}', { waitUntil: 'networkidle', timeout: 20000 });
      const title = await page.title();
      const text = await page.innerText('body').catch(() => '');
      console.log(JSON.stringify({ ok: true, title, url: page.url(), text: text.slice(0, \${MAX_OUT}) }));
    \`);
  },
});

export const screenshot = tool({
  description: "Take a screenshot of a webpage. Returns base64 PNG. Use when visual inspection is needed.",
  args: {
    url: tool.schema.string().describe("URL to screenshot"),
    fullPage: tool.schema.boolean().optional().describe("Capture full page (default: viewport only)"),
  },
  async execute(args) {
    const safeUrl = args.url.replace(/'/g, "\\\\'");
    return runPw(\`
      await page.goto('\${safeUrl}', { waitUntil: 'networkidle', timeout: 20000 });
      const buf = await page.screenshot({ fullPage: \${args.fullPage ?? false} });
      console.log(JSON.stringify({ ok: true, screenshot: buf.toString('base64') }));
    \`);
  },
});

export const execute = tool({
  description: "Run custom Playwright script on a page. For advanced automation (click, fill, assert, etc).",
  args: {
    url: tool.schema.string().describe("URL to navigate to"),
    script: tool.schema.string().describe("Playwright page actions (e.g. await page.click('button'); await page.fill('#email', 'test');)"),
  },
  async execute(args) {
    const safeUrl = args.url.replace(/'/g, "\\\\'");
    return runPw(\`
      await page.goto('\${safeUrl}', { waitUntil: 'networkidle', timeout: 20000 });
      \${args.script}
      const title = await page.title();
      const text = await page.innerText('body').catch(() => '');
      console.log(JSON.stringify({ ok: true, title, url: page.url(), text: text.slice(0, \${MAX_OUT}) }));
    \`);
  },
});

export const extract = tool({
  description: "Extract structured data from a page using CSS selectors.",
  args: {
    url: tool.schema.string().describe("URL to extract from"),
    selectors: tool.schema.string().describe("JSON object mapping field names to CSS selectors, e.g. {\\"title\\":\\"h1\\",\\"prices\\":\\".price\\"}"),
  },
  async execute(args) {
    const safeUrl = args.url.replace(/'/g, "\\\\'");
    let selectors;
    try {
      selectors = JSON.parse(args.selectors);
    } catch (err) {
      return JSON.stringify({ ok: false, error: \`Invalid selectors JSON: \${err.message}\` });
    }
    const entries = Object.entries(selectors)
      .map(([k, s]) => \`'\${k}': await page.locator('\${s.replace(/'/g, "\\\\'")}').allInnerTexts().catch(() => [])\`)
      .join(',\\n    ');
    return runPw(\`
      await page.goto('\${safeUrl}', { waitUntil: 'networkidle', timeout: 20000 });
      const data = { \${entries} };
      console.log(JSON.stringify({ ok: true, data }));
    \`);
  },
});

export const pdf = tool({
  description: "Generate a PDF of a webpage. Returns base64 PDF content.",
  args: { url: tool.schema.string().describe("URL to render as PDF") },
  async execute(args) {
    const safeUrl = args.url.replace(/'/g, "\\\\'");
    return runPw(\`
      await page.goto('\${safeUrl}', { waitUntil: 'networkidle', timeout: 20000 });
      const pdfPath = '/tmp/pw-page.pdf';
      await page.pdf({ path: pdfPath, format: 'A4' });
      const b64 = fs.readFileSync(pdfPath).toString('base64');
      fs.unlinkSync(pdfPath);
      console.log(JSON.stringify({ ok: true, pdf: b64 }));
    \`);
  },
});
`;
}

function buildNanoclawToolSource(ctx: AgentTurnContext): string {
  const canStart = ctx.containerInput.canStartWorkflow ? 'true' : 'false';
  return `
import { tool } from "@opencode-ai/plugin";
import fs from "fs";
import path from "path";

const IPC_DIR = "/workspace/ipc";
const MESSAGES_DIR = path.join(IPC_DIR, "messages");
const TASKS_DIR = path.join(IPC_DIR, "tasks");
const CHAT_JID = process.env.NANOCLAW_CHAT_JID || "";
const GROUP_FOLDER = process.env.NANOCLAW_GROUP_FOLDER || "";
const CAN_START_WORKFLOW = ${canStart};

function writeIpcFile(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const filename = \`\${Date.now()}-\${Math.random().toString(36).slice(2, 8)}.json\`;
  const filepath = path.join(dir, filename);
  const tempPath = \`\${filepath}.tmp\`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

export const send_message = tool({
  description: "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages.",
  args: {
    text: tool.schema.string().describe("The message text to send"),
    sender: tool.schema.string().optional().describe("Your role/identity name (e.g. 'Researcher')"),
  },
  async execute(args) {
    const data = {
      type: "message",
      chatJid: CHAT_JID,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder: GROUP_FOLDER,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return "Message sent.";
  },
});

${canStart ? `export const start_workflow = tool({
  description: "Start a workflow on the host. Use this to trigger multi-step processes like wiki synthesis via the quality-loop engine.",
  args: {
    title: tool.schema.string().describe('Workflow title (e.g. "Wiki Synthesis: 안전성검토")'),
    steps: tool.schema.array(
      tool.schema.object({
        assignee: tool.schema.string().describe("Agent or bot ID to assign the step to"),
        goal: tool.schema.string().describe("What this step should accomplish"),
        acceptance_criteria: tool.schema.array(tool.schema.string()).describe("Array of criteria strings. For quality-loop, include a JSON config string."),
        constraints: tool.schema.array(tool.schema.string()).optional().describe("Optional constraints"),
        stage_id: tool.schema.string().describe('Flow stage ID (e.g. "execute")'),
      })
    ).describe("Workflow steps to execute"),
  },
  async execute(args) {
    const data = {
      type: "start_workflow",
      chatJid: CHAT_JID,
      groupFolder: GROUP_FOLDER,
      title: args.title,
      steps: args.steps,
      timestamp: new Date().toISOString(),
    };
    const filename = writeIpcFile(TASKS_DIR, data);
    return \`Workflow "\${args.title}" submitted (\${filename}). The host will validate and start execution.\`;
  },
});` : '// start_workflow not enabled for this group'}
`;
}

function installCustomTools(ctx: AgentTurnContext): void {
  const toolsDir = path.join(WORK_DIR, '.opencode', 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });

  fs.writeFileSync(path.join(toolsDir, 'browser.ts'), buildAgentBrowserToolSource());
  fs.writeFileSync(path.join(toolsDir, 'playwright.ts'), buildPlaywrightToolSource());
  fs.writeFileSync(path.join(toolsDir, 'nanoclaw.ts'), buildNanoclawToolSource(ctx));
  ctx.log(`Custom tools installed: browser.ts, playwright.ts, nanoclaw.ts`);
}

/**
 * Parse OpenCode JSON event stream.
 * When --format json, each line is a JSON event.
 * We extract the final assistant message text.
 */
function parseJsonOutput(stdout: string, log: (msg: string) => void): string {
  let resultText = '';

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);

      // Text events: { type: "text", part: { type: "text", text: "..." } }
      if (event.type === 'text' && event.part?.text) {
        resultText += event.part.text;
      }

      // Tool use events for debugging
      if (event.type === 'tool_use' || event.type === 'tool-start') {
        const name = event.part?.tool || event.part?.name || event.type;
        log(`tool: ${name}`);
      }
      if (event.type === 'tool_result' || event.type === 'tool-end') {
        const name = event.part?.tool || event.part?.name || event.type;
        log(`tool done: ${name}`);
      }

      // Step finish for cost/token logging
      if (event.type === 'step_finish' && event.part?.tokens) {
        const t = event.part.tokens;
        log(`tokens: input=${t.input} output=${t.output} cost=${event.part.cost || 0}`);
      }
    } catch {
      // Non-JSON line — skip
    }
  }

  return resultText.trim();
}

const OPENCODE_SESSION_FILE = path.join(WORK_DIR, '.opencode-session.json');

interface OpenCodeSessionMap {
  [nanoclawSessionId: string]: string;
}

function loadOpenCodeSessionId(nanoclawSessionId: string): string | undefined {
  try {
    if (!fs.existsSync(OPENCODE_SESSION_FILE)) return undefined;
    const map: OpenCodeSessionMap = JSON.parse(
      fs.readFileSync(OPENCODE_SESSION_FILE, 'utf-8'),
    );
    return map[nanoclawSessionId];
  } catch {
    return undefined;
  }
}

function saveOpenCodeSessionId(nanoclawSessionId: string, opencodeSessionId: string): void {
  try {
    let map: OpenCodeSessionMap = {};
    if (fs.existsSync(OPENCODE_SESSION_FILE)) {
      map = JSON.parse(fs.readFileSync(OPENCODE_SESSION_FILE, 'utf-8'));
    }
    map[nanoclawSessionId] = opencodeSessionId;
    fs.writeFileSync(OPENCODE_SESSION_FILE, JSON.stringify(map, null, 2));
  } catch {
    // ignore
  }
}

function extractOpenCodeSessionId(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.sessionID) return event.sessionID;
    } catch {
      // ignore
    }
  }
  return undefined;
}

async function runOpencodeTurn(
  context: AgentTurnContext,
): Promise<AgentTurnResult> {
  const nanoclawSessionId = context.sessionId || crypto.randomUUID();
  const model = context.agentEnv.OPENCODE_MODEL || DEFAULT_OPENCODE_MODEL;
  const apiKey = context.agentEnv.OPENCODE_API_KEY || '';

  context.log(
    `OpenCode CLI turn (nanoclaw session: ${nanoclawSessionId}, model: ${model})`,
  );

  try {
    // Setup: write config and install custom tools
    writeConfig(model, context);
    installCustomTools(context);

    // Build environment
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(context.agentEnv)) {
      if (typeof v === 'string') env[k] = v;
    }
    if (apiKey) env.OPENCODE_API_KEY = apiKey;

    // Session continuation — use opencode-specific session ID (different from nanoclaw's)
    const opencodeSessionId = loadOpenCodeSessionId(nanoclawSessionId);
    const args = ['run'];
    if (opencodeSessionId) {
      args.push('--session', opencodeSessionId);
      context.log(`Resuming opencode session: ${opencodeSessionId}`);
    }
    args.push('--format', 'json');
    args.push('--model', model);
    args.push(context.prompt);

    context.log(`Executing: opencode ${args.join(' ').slice(0, 200)}`);

    const { stdout, stderr } = await runCommandWithClosedStdin(
      'opencode',
      args,
      {
        cwd: WORK_DIR,
        timeoutMs: OPENCODE_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT * 2,
        env,
        log: context.log,
      },
    );

    if (stderr) {
      context.log(`OpenCode stderr: ${stderr.slice(0, 500)}`);
    }

    // Parse output
    let resultText = parseJsonOutput(stdout, context.log);

    // Fallback: if JSON parsing got nothing, use raw stdout
    if (!resultText && stdout.trim()) {
      resultText = stdout.trim().slice(0, MAX_OUTPUT);
    }

    // Strip reasoning traces
    resultText = resultText
      .replace(/^(?:The user (?:is|was|has) [\s\S]*?\n)+/i, '')
      .replace(/^(?:I (?:should|need to|will|can) [\s\S]*?\n)+/i, '')
      .trim();

    // Save opencode session ID for future resume
    const newOpencodeSessionId = extractOpenCodeSessionId(stdout);
    if (newOpencodeSessionId) {
      saveOpenCodeSessionId(nanoclawSessionId, newOpencodeSessionId);
      context.log(`Saved opencode session: ${newOpencodeSessionId}`);
    }

    context.log(`OpenCode response received (${resultText.length} chars)`);

    context.emitOutput({
      status: 'success',
      result: resultText || null,
      newSessionId: nanoclawSessionId,
    });

    return {
      newSessionId: nanoclawSessionId,
      closedDuringQuery: false,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    context.log(`OpenCode error: ${errorMsg}`);
    context.emitOutput({ status: 'error', result: null, error: errorMsg });
    return { closedDuringQuery: false };
  }
}

export const opencodeProvider: AgentProvider = {
  name: 'opencode',
  runTurn: runOpencodeTurn,
};
