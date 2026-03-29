/**
 * OpenCode Provider (Refactored)
 *
 * Uses OpenCode CLI `run` command instead of the limited SDK API.
 * This gives full access to OpenCode's built-in tools (bash, read, write,
 * edit, grep, glob, webfetch, websearch, etc.), MCP servers, and custom tools.
 *
 * Architecture:
 *   1. Generate opencode.jsonc config with model, MCP servers, tool permissions
 *   2. Copy custom tools to .opencode/tools/ (agent-browser, playwright wrappers)
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
import { execFile } from 'child_process';
import { promisify } from 'util';

import {
  buildInstructionSections,
  materializeInstructionFiles,
} from '../agent-instructions.js';
import {
  AgentProvider,
  AgentTurnContext,
  AgentTurnResult,
} from '../types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_OPENCODE_MODEL = 'opencode-go/kimi-k2.5';
const OPENCODE_TIMEOUT_MS = 300_000;
const MAX_OUTPUT = 200_000;
const WORK_DIR = '/workspace/group';
const CONFIG_DIR = '/workspace/group';

/**
 * Write opencode.jsonc config for this session.
 * Configures model, provider, tool permissions, and MCP servers.
 */
function writeConfig(
  model: string,
  ctx: AgentTurnContext,
): void {
  const mcpServerPath = ctx.mcpServerPath;

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
    // MCP servers
    mcp: {
      nanoclaw: {
        type: 'local',
        command: ['node', mcpServerPath],
        environment: {
          NANOCLAW_CHAT_JID: ctx.containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: ctx.containerInput.groupFolder,
          NANOCLAW_IS_MAIN: ctx.containerInput.isMain ? '1' : '0',
        },
      },
    },
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
function installCustomTools(ctx: AgentTurnContext): void {
  const toolsDir = path.join(WORK_DIR, '.opencode', 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });

  // agent-browser tool — lightweight browsing via accessibility snapshots
  const agentBrowserTool = `
import { tool } from "opencode/tool";
import { z } from "zod";
import { execSync } from "child_process";

const TIMEOUT = 30000;
const run = (args) => {
  try {
    return execSync(\`agent-browser \${args}\`, { timeout: TIMEOUT, maxBuffer: 100000 }).toString().trim();
  } catch (e) { return \`Error: \${e.message}\`; }
};

export const open = tool({
  description: "Open a URL in the browser and return accessibility snapshot with interactive element refs (@e1, @e2...). Token-efficient. Use for most browsing.",
  args: { url: z.string().describe("URL to open") },
  async execute(args) {
    run(\`open \${args.url}\`);
    run("wait --load networkidle");
    const snapshot = run("snapshot -i");
    const title = run("get title");
    const url = run("get url");
    return \`Page: \${title}\\nURL: \${url}\\n\\nInteractive elements:\\n\${snapshot}\`;
  },
});

export const click = tool({
  description: "Click an element by ref (e.g. @e1) and return updated snapshot.",
  args: { ref: z.string().describe("Element ref like @e1") },
  async execute(args) {
    run(\`click \${args.ref}\`);
    const snapshot = run("snapshot -i");
    return snapshot;
  },
});

export const fill = tool({
  description: "Fill a form field by ref with text.",
  args: {
    ref: z.string().describe("Element ref like @e1"),
    text: z.string().describe("Text to fill"),
  },
  async execute(args) {
    run(\`fill \${args.ref} "\${args.text}"\`);
    const snapshot = run("snapshot -i");
    return snapshot;
  },
});

export const select = tool({
  description: "Select a dropdown option by ref.",
  args: {
    ref: z.string().describe("Element ref like @e1"),
    option: z.string().describe("Option to select"),
  },
  async execute(args) {
    run(\`select \${args.ref} "\${args.option}"\`);
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
  args: { ref: z.string().optional().describe("Element ref (omit for full page)") },
  async execute(args) {
    return args.ref ? run(\`get text \${args.ref}\`) : run("get text");
  },
});

export const press = tool({
  description: "Press a keyboard key (e.g. Enter, Tab, Escape).",
  args: { key: z.string().describe("Key to press") },
  async execute(args) {
    run(\`press \${args.key}\`);
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

  // playwright tool — full browser control
  const playwrightTool = `
import { tool } from "opencode/tool";
import { z } from "zod";
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
  args: { url: z.string().describe("URL to open") },
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
    url: z.string().describe("URL to screenshot"),
    fullPage: z.boolean().optional().describe("Capture full page (default: viewport only)"),
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
    url: z.string().describe("URL to navigate to"),
    script: z.string().describe("Playwright page actions (e.g. await page.click('button'); await page.fill('#email', 'test');)"),
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
    url: z.string().describe("URL to extract from"),
    selectors: z.record(z.string()).describe("Map of name to CSS selector, e.g. { title: 'h1', prices: '.price' }"),
  },
  async execute(args) {
    const safeUrl = args.url.replace(/'/g, "\\\\'");
    const entries = Object.entries(args.selectors)
      .map(([k, s]) => \`'\${k}': await page.locator('\${s.replace(/'/g, "\\\\'")}').allInnerTexts().catch(() => [])\`)
      .join(',\\n    ');
    return runPw(\`
      await page.goto('\${safeUrl}', { waitUntil: 'networkidle', timeout: 20000 });
      const data = { \${entries} };
      console.log(JSON.stringify({ ok: true, data }));
    \`);
  },
});
`;

  fs.writeFileSync(path.join(toolsDir, 'browser.ts'), agentBrowserTool);
  fs.writeFileSync(path.join(toolsDir, 'playwright.ts'), playwrightTool);
  ctx.log(`Custom tools installed: browser.ts, playwright.ts`);
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

async function runOpencodeTurn(
  context: AgentTurnContext,
): Promise<AgentTurnResult> {
  const sessionId = context.sessionId || crypto.randomUUID();
  const model = context.agentEnv.OPENCODE_MODEL || DEFAULT_OPENCODE_MODEL;
  const apiKey = context.agentEnv.OPENCODE_API_KEY || '';

  context.log(
    `OpenCode CLI turn (session: ${sessionId}, model: ${model})`,
  );

  if (!apiKey) {
    const errorMsg = 'OPENCODE_API_KEY is not set';
    context.log(`Error: ${errorMsg}`);
    context.emitOutput({ status: 'error', result: null, error: errorMsg });
    return { closedDuringQuery: false };
  }

  try {
    // Setup: write config and install custom tools
    writeConfig(model, context);
    installCustomTools(context);

    // Build environment
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(context.agentEnv)) {
      if (typeof v === 'string') env[k] = v;
    }
    env.OPENCODE_API_KEY = apiKey;

    // Session continuation
    const args = ['run'];
    if (context.sessionId) {
      args.push('--session', context.sessionId);
    }
    args.push('--format', 'json');
    args.push('--model', model);
    args.push(context.prompt);

    context.log(`Executing: opencode ${args.join(' ').slice(0, 200)}`);

    const { stdout, stderr } = await execFileAsync('opencode', args, {
      cwd: WORK_DIR,
      timeout: OPENCODE_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT * 2,
      env,
    });

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

    context.log(`OpenCode response received (${resultText.length} chars)`);

    context.emitOutput({
      status: 'success',
      result: resultText || null,
      newSessionId: sessionId,
    });

    return {
      newSessionId: sessionId,
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
