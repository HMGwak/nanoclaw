/**
 * Shared tool definitions and executor for OpenAI-style providers.
 * Both openai.ts and openai-compat.ts import from here.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadSubAgentManager } from '../sub-agent-manager.js';
import { normalizeVaultRoot, toHostPath, findFileByDomain } from './wiki-utils.js';
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
import {
  runDebateWithAgents,
  validateDebateRequest,
} from './debate-orchestration.js';
import { ToolContext } from './types.js';

const execFileAsync = promisify(execFile);

const IPC_DIR = '/workspace/ipc';
const IPC_MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const IPC_TASKS_DIR = path.join(IPC_DIR, 'tasks');

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

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
  chatJid?: string;
  groupFolder?: string;
  isMain?: boolean;
  emitText?: (text: string) => void;
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

  // Browser Rendering first when credentials are present.
  const cfReady = Boolean(
    ctx.env.CF_ACCOUNT_ID?.trim() && ctx.env.CF_API_TOKEN?.trim(),
  );
  if (cfReady) {
    const cfResult = await runCloudflareFetch(argsJson, ctx);
    try {
      const parsed = JSON.parse(cfResult) as { ok?: boolean };
      if (parsed.ok) return cfResult;
    } catch {
      // Ignore parse failure and continue to curl fallback.
    }
  }

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

async function runCloudflareFetch(
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

  const accountId = ctx.env.CF_ACCOUNT_ID?.trim();
  const apiToken = ctx.env.CF_API_TOKEN?.trim();
  if (!accountId || !apiToken) {
    return JSON.stringify({
      ok: false,
      provider: 'cloudflare-browser-rendering',
      error: 'CF_ACCOUNT_ID or CF_API_TOKEN is not configured.',
    });
  }

  ctx.log(`cloudflare_fetch: ${url}`);
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/content`;
  const payload = JSON.stringify({
    url,
    gotoOptions: { waitUntil: 'networkidle2' },
  });
  const env = Object.fromEntries(
    Object.entries(ctx.env).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    ),
  );

  try {
    const { stdout, stderr } = await execFileAsync(
      '/usr/bin/curl',
      [
        '-L',
        '--silent',
        '--show-error',
        '--max-time',
        '60',
        '-X',
        'POST',
        endpoint,
        '-H',
        `Authorization: Bearer ${apiToken}`,
        '-H',
        'Content-Type: application/json',
        '--data',
        payload,
      ],
      {
        cwd: '/workspace/group',
        timeout: DEFAULT_WEB_TIMEOUT_MS * 2,
        maxBuffer: MAX_TOOL_OUTPUT_CHARS * 2,
        env,
      },
    );

    try {
      const parsed = JSON.parse(stdout) as {
        success?: boolean;
        errors?: Array<{ message?: string }>;
        result?: unknown;
      };
      if (parsed.success === false) {
        const errorMessage =
          parsed.errors?.map((e) => e.message).filter(Boolean).join('; ') ||
          'Cloudflare Browser Rendering request failed';
        return JSON.stringify({
          ok: false,
          provider: 'cloudflare-browser-rendering',
          url,
          error: errorMessage,
        });
      }
      const rendered =
        typeof parsed.result === 'string'
          ? parsed.result
          : JSON.stringify(parsed.result ?? parsed);
      return JSON.stringify({
        ok: true,
        provider: 'cloudflare-browser-rendering',
        url,
        body: truncateOutput(rendered),
        stderr: truncateOutput(stderr),
      });
    } catch {
      return JSON.stringify({
        ok: true,
        provider: 'cloudflare-browser-rendering',
        url,
        body: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
      });
    }
  } catch (err) {
    const e = err as { message?: string };
    return JSON.stringify({
      ok: false,
      provider: 'cloudflare-browser-rendering',
      url,
      error: e.message,
    });
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
  const fetched = await runWebFetch(
    JSON.stringify({
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    }),
    ctx,
  );

  // DuckDuckGo sometimes returns anti-bot challenge pages.
  // Returning this as a normal "ok" body makes the model think search succeeded.
  // Detect known challenge markers and force the model to switch to browser tools.
  try {
    const parsed = JSON.parse(fetched) as {
      ok?: boolean;
      body?: string;
      url?: string;
    };
    const body = (parsed.body || '').toLowerCase();
    const blocked =
      body.includes('anomaly.js') ||
      body.includes('automated traffic') ||
      body.includes('verify you are human') ||
      body.includes('duckduckgo.com/anomaly') ||
      body.includes('bot challenge');
    if (parsed.ok && blocked) {
      return JSON.stringify({
        ok: false,
        provider: 'duckduckgo',
        error: 'search provider blocked by anti-bot challenge',
        hint: 'Use cloudflare_fetch on a direct trusted source URL, then fall back to browse_open and Playwright only if needed.',
        url: parsed.url,
      });
    }
  } catch {
    // Ignore parse failures and return the raw fetch output.
  }

  return fetched;
}

async function runListAgents(_ctx: ExecutorContext): Promise<string> {
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

async function runDebate(
  argsJson: string,
  ctx: ExecutorContext,
): Promise<string> {
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return JSON.stringify({ ok: false, error: 'Invalid JSON' });
  }

  const parsed = validateDebateRequest(args);
  if (!parsed.ok) {
    return JSON.stringify(parsed);
  }

  const manager = getSubAgentManager();
  if (!manager || manager.size === 0) {
    return JSON.stringify({
      ok: false,
      error: 'run_debate requires configured internal debate participants',
    });
  }

  ctx.log(
    `run_debate: mode=${parsed.request.mode} topic=${parsed.request.topic.slice(0, 120)}`,
  );
  ctx.emitText?.(
    [
      '내부 토론을 시작합니다.',
      `- 주제: ${parsed.request.topic}`,
      `- 모드: ${parsed.request.mode}`,
      `- 라운드 수: ${parsed.request.rounds}`,
      '- 각 라운드가 끝날 때마다 중간 요약을 공유하고, 마지막에 최종 결론을 정리합니다.',
    ].join('\n'),
  );
  return JSON.stringify(
    await runDebateWithAgents(parsed.request, manager, ctx.log, (message) => {
      ctx.emitText?.(message);
    }),
  );
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
    case 'cloudflare_fetch':
      return runCloudflareFetch(argsJson, ctx);
    case 'web_search':
      return runWebSearch(argsJson, ctx);
    case 'list_agents':
      return runListAgents(ctx);
    case 'ask_agent':
      return runAskAgent(argsJson, ctx);
    case 'run_debate':
      return runDebate(argsJson, ctx);

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

    // IPC tools
    case 'send_message': {
      const a = JSON.parse(argsJson);
      const chatJid = ctx.chatJid || ctx.env.NANOCLAW_CHAT_JID || '';
      const groupFolder = ctx.groupFolder || ctx.env.NANOCLAW_GROUP_FOLDER || '';
      const data = {
        type: 'message',
        chatJid,
        text: a.text,
        sender: a.sender || undefined,
        groupFolder,
        timestamp: new Date().toISOString(),
      };
      writeIpcFile(IPC_MESSAGES_DIR, data);
      ctx.log(`IPC send_message: ${a.text.slice(0, 100)}`);
      return JSON.stringify({ ok: true, message: 'Message sent.' });
    }
    case 'start_workflow': {
      const canStart = ctx.env.NANOCLAW_CAN_START_WORKFLOW === '1';
      if (!canStart) {
        return JSON.stringify({ ok: false, error: 'Workflow start not permitted for this group.' });
      }
      const a = JSON.parse(argsJson);
      const chatJid = ctx.chatJid || ctx.env.NANOCLAW_CHAT_JID || '';
      const groupFolder = ctx.groupFolder || ctx.env.NANOCLAW_GROUP_FOLDER || '';
      const data = {
        type: 'start_workflow',
        chatJid,
        groupFolder,
        title: a.title,
        steps: a.steps,
        timestamp: new Date().toISOString(),
      };
      const filename = writeIpcFile(IPC_TASKS_DIR, data);
      ctx.log(`IPC start_workflow: ${a.title} → ${filename}`);
      return JSON.stringify({ ok: true, message: `Workflow "${a.title}" submitted (${filename}).` });
    }
    case 'wiki_synthesis': {
      const canStart = ctx.env.NANOCLAW_CAN_START_WORKFLOW === '1';
      if (!canStart) {
        return JSON.stringify({ ok: false, error: 'Workflow start not permitted for this group.' });
      }
      const a = JSON.parse(argsJson) as {
        domain: string;
        wiki_output_dir: string;
        base_file?: string;
        filter?: string;
        vault_root?: string;
        model?: string;
      };
      // Always use the host path — never pass container paths (/workspace/...)
      // to the quality loop engine, which runs in the core container.
      const DEFAULT_VAULT_HOST_PATH =
        process.env.NANOCLAW_SECRETARY_OBSIDIAN_VAULT_HOST_PATH?.trim() ||
        '/Users/planee/Documents/Mywork';
      const rawVaultRoot = a.vault_root || DEFAULT_VAULT_HOST_PATH;
      const vaultRoot = normalizeVaultRoot(rawVaultRoot, DEFAULT_VAULT_HOST_PATH);

      const basePath = a.base_file || findFileByDomain(
        [
          '/workspace/extra/vault/3. Resource/LLM Knowledge Base/index',
          '/workspace/extra/obsidian-vault/3. Resource/LLM Knowledge Base/index',
        ],
        '.base',
        a.domain,
      );

      const qualityLoopConfig: Record<string, string> = {
        task: 'catalog.tasks.wiki.task.WikiTask',
        domain: a.domain,
        vault_root: vaultRoot,
        wiki_output_dir: a.wiki_output_dir,
      };
      if (basePath) qualityLoopConfig.base = toHostPath(basePath, vaultRoot);
      if (a.filter) qualityLoopConfig.filter = a.filter;
      if (a.model) qualityLoopConfig.model = a.model;

      const chatJid = ctx.chatJid || ctx.env.NANOCLAW_CHAT_JID || '';
      const groupFolder = ctx.groupFolder || ctx.env.NANOCLAW_GROUP_FOLDER || '';
      const data = {
        type: 'start_workflow',
        chatJid,
        groupFolder,
        title: `Wiki Synthesis: ${a.domain}`,
        steps: [
          {
            assignee: groupFolder,
            goal: `${a.domain} 도메인의 wiki note를 raw 문서에서 합성`,
            acceptance_criteria: [JSON.stringify(qualityLoopConfig)],
            constraints: ['Archive 폴더 문서만 대상', 'hallucination 금지'],
            stage_id: 'execute',
          },
        ],
        timestamp: new Date().toISOString(),
      };
      const wikiFilename = writeIpcFile(IPC_TASKS_DIR, data);
      ctx.log(`IPC wiki_synthesis: ${a.domain} → ${wikiFilename}`);
      return JSON.stringify({
        ok: true,
        message: `Wiki synthesis workflow started for domain "${a.domain}" (${wikiFilename}). The quality-loop engine will run and write results to ${a.wiki_output_dir}.`,
      });
    }
    case 'safe_shell': {
      const SAFE_SHELL_ALLOWED = /^(python3?|ls|find|cat|head|tail|grep|echo|which|wc|stat|file)\b/;
      const SAFE_SHELL_BLOCKED = /\brm\b|\brmdir\b|\bmv\b|\bcp\b|\bchmod\b|\bchown\b|\bdd\b|\bmkfs\b|\btruncate\b|>|>>|\btee\b|\bsqlite3\b|\bsql\b|\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i;
      const a = JSON.parse(argsJson) as { command: string };
      const cmd = a.command.trim();
      if (!SAFE_SHELL_ALLOWED.test(cmd)) {
        return JSON.stringify({
          ok: false,
          error: 'Command not in allowlist. Permitted: python, ls, find, cat, head, tail, grep, echo, which, wc, stat, file',
        });
      }
      if (SAFE_SHELL_BLOCKED.test(cmd)) {
        return JSON.stringify({ ok: false, error: 'Destructive operation not allowed.' });
      }
      const env = Object.fromEntries(
        Object.entries(ctx.env).filter((e): e is [string, string] => typeof e[1] === 'string'),
      );
      try {
        const { stdout, stderr } = await execFileAsync('/bin/bash', ['-c', cmd], {
          cwd: '/workspace/group',
          timeout: 10_000,
          maxBuffer: 256 * 1024,
          env,
        });
        return JSON.stringify({ ok: true, stdout: truncateOutput(stdout), stderr: truncateOutput(stderr) });
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

    default:
      return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
  }
}
