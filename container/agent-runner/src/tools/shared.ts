/**
 * Shared tool definitions and executor for OpenAI-style providers.
 * Both openai.ts and openai-compat.ts import from here.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadSubAgentManager } from '../sub-agent-manager.js';
import {
  agentBrowseOpen,
  agentBrowseClick,
  agentBrowseFill,
  agentBrowseSelect,
  agentBrowseSnapshot,
  agentBrowseScreenshot,
  agentBrowseGetText,
  agentBrowsePress,
  agentBrowseClose,
} from './browse-agent.js';
import {
  playwrightOpen,
  playwrightScreenshot,
  playwrightExecute,
  playwrightExtract,
  playwrightPdf,
} from './browse-playwright.js';
import { ToolContext } from './types.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
export const DEFAULT_WEB_TIMEOUT_MS = 45_000;
export const MAX_TOOL_OUTPUT_CHARS = 120_000;

export function truncateOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n...<truncated>';
}

// --- Tool executor ---

interface ExecutorContext {
  log: (msg: string) => void;
  env: Record<string, string | undefined>;
}

function getSubAgentManager() {
  return loadSubAgentManager();
}

async function runShell(
  argsJson: string,
  ctx: ExecutorContext,
): Promise<string> {
  let args: { command: string; working_directory?: string };
  try {
    args = JSON.parse(argsJson);
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const command = args.command?.trim();
  if (!command) return JSON.stringify({ ok: false, error: 'Empty command' });

  const cwd = args.working_directory || '/workspace/group';
  ctx.log(`shell: cwd=${cwd} cmd=${command.slice(0, 200)}`);

  const env = Object.fromEntries(
    Object.entries(ctx.env).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    ),
  );
  try {
    const { stdout, stderr } = await execFileAsync(
      '/bin/bash',
      ['-lc', command],
      {
        cwd,
        timeout: DEFAULT_SHELL_TIMEOUT_MS,
        maxBuffer: MAX_TOOL_OUTPUT_CHARS * 2,
        env,
      },
    );
    return JSON.stringify({
      ok: true,
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return JSON.stringify({
      ok: false,
      stdout: truncateOutput(e.stdout || ''),
      stderr: truncateOutput(e.stderr || ''),
      error: e.message,
    });
  }
}

async function runWebFetch(
  argsJson: string,
  ctx: ExecutorContext,
): Promise<string> {
  let args: { url: string };
  try {
    args = JSON.parse(argsJson);
  } catch {
    return JSON.stringify({ ok: false, error: 'Invalid JSON' });
  }
  const url = args.url?.trim();
  if (!url) return JSON.stringify({ ok: false, error: 'No URL' });

  ctx.log(`web_fetch: ${url}`);
  const env = Object.fromEntries(
    Object.entries(ctx.env).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    ),
  );
  try {
    const { stdout, stderr } = await execFileAsync(
      '/usr/bin/curl',
      ['-L', '--silent', '--show-error', '--max-time', '45', url],
      {
        cwd: '/workspace/group',
        timeout: DEFAULT_WEB_TIMEOUT_MS,
        maxBuffer: MAX_TOOL_OUTPUT_CHARS * 2,
        env,
      },
    );
    return JSON.stringify({
      ok: true,
      url,
      body: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
    });
  } catch (err) {
    const e = err as { message?: string };
    return JSON.stringify({ ok: false, url, error: e.message });
  }
}

async function runWebSearch(
  argsJson: string,
  ctx: ExecutorContext,
): Promise<string> {
  let args: { query: string };
  try {
    args = JSON.parse(argsJson);
  } catch {
    return JSON.stringify({ ok: false, error: 'Invalid JSON' });
  }
  const query = args.query?.trim();
  if (!query) return JSON.stringify({ ok: false, error: 'No query' });
  return runWebFetch(
    JSON.stringify({
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    }),
    ctx,
  );
}

async function runListAgents(ctx: ExecutorContext): Promise<string> {
  const manager = getSubAgentManager();
  if (!manager || manager.size === 0) {
    return JSON.stringify({ ok: true, agents: [] });
  }

  return JSON.stringify({
    ok: true,
    agents: manager.listAgents(),
  });
}

async function runAskAgent(
  argsJson: string,
  ctx: ExecutorContext,
): Promise<string> {
  let args: { agent: string; prompt: string; system_prompt?: string };
  try {
    args = JSON.parse(argsJson);
  } catch {
    return JSON.stringify({ ok: false, error: 'Invalid JSON' });
  }

  if (!args.agent?.trim()) {
    return JSON.stringify({ ok: false, error: 'No agent specified' });
  }
  if (!args.prompt?.trim()) {
    return JSON.stringify({ ok: false, error: 'No prompt provided' });
  }

  const manager = getSubAgentManager();
  if (!manager || manager.size === 0) {
    return JSON.stringify({ ok: false, error: 'No sub-agents configured' });
  }

  ctx.log(`ask_agent: ${args.agent}`);

  try {
    const response = await manager.askAgent(
      args.agent,
      args.prompt,
      args.system_prompt,
    );
    return JSON.stringify({
      ok: true,
      agent: args.agent,
      response,
    });
  } catch (err) {
    return JSON.stringify({
      ok: false,
      agent: args.agent,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function toToolCtx(ctx: ExecutorContext): ToolContext {
  return { log: ctx.log, env: ctx.env as Record<string, string | undefined> };
}

export async function executeTool(
  name: string,
  argsJson: string,
  ctx: ExecutorContext,
): Promise<string> {
  const tc = toToolCtx(ctx);

  switch (name) {
    // Core tools
    case 'shell':
      return runShell(argsJson, ctx);
    case 'web_fetch':
      return runWebFetch(argsJson, ctx);
    case 'web_search':
      return runWebSearch(argsJson, ctx);
    case 'list_agents':
      return runListAgents(ctx);
    case 'ask_agent':
      return runAskAgent(argsJson, ctx);

    // Agent Browser tools
    case 'browse_open': {
      const a = JSON.parse(argsJson);
      return JSON.stringify(await agentBrowseOpen(a.url, tc));
    }
    case 'browse_click': {
      const a = JSON.parse(argsJson);
      return JSON.stringify(await agentBrowseClick(a.ref, tc));
    }
    case 'browse_fill': {
      const a = JSON.parse(argsJson);
      return JSON.stringify(await agentBrowseFill(a.ref, a.text, tc));
    }
    case 'browse_select': {
      const a = JSON.parse(argsJson);
      return JSON.stringify(await agentBrowseSelect(a.ref, a.option, tc));
    }
    case 'browse_snapshot':
      return JSON.stringify(await agentBrowseSnapshot(tc));
    case 'browse_screenshot':
      return JSON.stringify(await agentBrowseScreenshot(tc));
    case 'browse_get_text': {
      const a = JSON.parse(argsJson);
      return JSON.stringify(await agentBrowseGetText(a.ref, tc));
    }
    case 'browse_press': {
      const a = JSON.parse(argsJson);
      return JSON.stringify(await agentBrowsePress(a.key, tc));
    }
    case 'browse_close':
      return JSON.stringify(await agentBrowseClose(tc));

    // Playwright tools
    case 'playwright_open': {
      const a = JSON.parse(argsJson);
      return JSON.stringify(await playwrightOpen(a.url, tc));
    }
    case 'playwright_screenshot': {
      const a = JSON.parse(argsJson);
      return JSON.stringify(
        await playwrightScreenshot(a.url, tc, { fullPage: a.fullPage }),
      );
    }
    case 'playwright_execute': {
      const a = JSON.parse(argsJson);
      return JSON.stringify(await playwrightExecute(a.url, a.script, tc));
    }
    case 'playwright_extract': {
      const a = JSON.parse(argsJson);
      return JSON.stringify(await playwrightExtract(a.url, a.selectors, tc));
    }
    case 'playwright_pdf': {
      const a = JSON.parse(argsJson);
      return JSON.stringify(await playwrightPdf(a.url, tc));
    }

    default:
      return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
  }
}
