/**
 * Shared tool definitions and executor for OpenAI-style providers.
 * Both openai.ts and openai-compat.ts import from here.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
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
  chatJid?: string;
  groupFolder?: string;
  isMain?: boolean;
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

const IPC_TASKS_DIR = '/workspace/ipc/tasks';
const KARPATHY_STAGE_IDS = [
  'baseline',
  'change',
  'run',
  'verify',
  'decide',
  'collect',
  'report',
] as const;
const KARPATHY_STAGE_ID_SET = new Set<string>(KARPATHY_STAGE_IDS);

function writeIpcTask(data: Record<string, unknown>): string {
  fs.mkdirSync(IPC_TASKS_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(IPC_TASKS_DIR, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

type RawWorkflowStep = {
  assignee?: unknown;
  goal?: unknown;
  acceptance_criteria?: unknown;
  constraints?: unknown;
  stage_id?: unknown;
};

type RawWorkflowIntakeStep = {
  assignee?: unknown;
  goal?: unknown;
  acceptance_criteria?: unknown;
  constraints?: unknown;
  stage_id?: unknown;
};

type SanitizedWorkflowStep = {
  assignee: string;
  goal: string;
  acceptance_criteria: string | string[];
  constraints: string | string[];
  stage_id: string;
};

type WorkflowIntakeMissingField = {
  field: string;
  question: string;
  issue: 'missing' | 'invalid';
};

function normalizeRequiredTextList(
  value: unknown,
): string | string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function sanitizeWorkflowStep(
  raw: unknown,
  index: number,
): { ok: true; step: SanitizedWorkflowStep } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      error: `steps[${index}] must be an object with assignee and goal`,
    };
  }
  const step = raw as RawWorkflowStep;
  const assignee =
    typeof step.assignee === 'string' ? step.assignee.trim() : '';
  const goal = typeof step.goal === 'string' ? step.goal.trim() : '';
  if (!assignee || !goal) {
    return {
      ok: false,
      error: `steps[${index}] must include non-empty assignee and goal`,
    };
  }

  const acceptanceCriteria = normalizeRequiredTextList(
    step.acceptance_criteria,
  );
  if (acceptanceCriteria === undefined) {
    return {
      ok: false,
      error: `steps[${index}].acceptance_criteria is required and must be a non-empty string or non-empty string array`,
    };
  }

  const constraints = normalizeRequiredTextList(step.constraints);
  if (constraints === undefined) {
    return {
      ok: false,
      error: `steps[${index}].constraints is required and must be a non-empty string or non-empty string array`,
    };
  }

  if (typeof step.stage_id !== 'string' || step.stage_id.trim().length === 0) {
    return {
      ok: false,
      error: `steps[${index}].stage_id is required and must be a non-empty string`,
    };
  }
  const stageId = step.stage_id.trim();

  return {
    ok: true,
    step: {
      assignee,
      goal,
      acceptance_criteria: acceptanceCriteria,
      constraints,
      stage_id: stageId,
    },
  };
}

function normalizeRequiredString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function collectWorkflowIntakeMissingFields(
  title: unknown,
  steps: unknown,
): {
  preparedTitle?: string;
  preparedSteps: SanitizedWorkflowStep[];
  missing: WorkflowIntakeMissingField[];
} {
  const missing: WorkflowIntakeMissingField[] = [];
  const preparedTitle = normalizeRequiredString(title);
  if (!preparedTitle) {
    missing.push({
      field: 'title',
      issue: 'missing',
      question: '워크플로우 제목(title)을 알려주세요.',
    });
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    missing.push({
      field: 'steps',
      issue: 'missing',
      question:
        '최소 1개 이상의 step을 제공해주세요. 각 step에는 assignee/goal/acceptance_criteria/constraints/stage_id가 필요합니다.',
    });
    return { preparedTitle, preparedSteps: [], missing };
  }

  const preparedSteps: SanitizedWorkflowStep[] = [];
  steps.forEach((rawStep, index) => {
    if (!rawStep || typeof rawStep !== 'object') {
      missing.push({
        field: `steps[${index}]`,
        issue: 'invalid',
        question: `steps[${index}]를 객체 형태로 제공해주세요.`,
      });
      return;
    }
    const step = rawStep as RawWorkflowIntakeStep;

    const assignee = normalizeRequiredString(step.assignee);
    if (!assignee) {
      missing.push({
        field: `steps[${index}].assignee`,
        issue: 'missing',
        question: `steps[${index}] assignee(담당 그룹 folder)를 지정해주세요.`,
      });
    }

    const goal = normalizeRequiredString(step.goal);
    if (!goal) {
      missing.push({
        field: `steps[${index}].goal`,
        issue: 'missing',
        question: `steps[${index}] goal(무엇을 달성해야 하는지)을 지정해주세요.`,
      });
    }

    const acceptanceCriteria = normalizeRequiredTextList(step.acceptance_criteria);
    if (!acceptanceCriteria) {
      missing.push({
        field: `steps[${index}].acceptance_criteria`,
        issue: 'missing',
        question: `steps[${index}] acceptance_criteria(완료 판정 기준)를 지정해주세요.`,
      });
    }

    const constraints = normalizeRequiredTextList(step.constraints);
    if (!constraints) {
      missing.push({
        field: `steps[${index}].constraints`,
        issue: 'missing',
        question: `steps[${index}] constraints(제약사항)를 지정해주세요.`,
      });
    }

    const stageId = normalizeRequiredString(step.stage_id);
    if (!stageId) {
      missing.push({
        field: `steps[${index}].stage_id`,
        issue: 'missing',
        question: `steps[${index}] stage_id를 지정해주세요. 허용값: ${KARPATHY_STAGE_IDS.join(', ')}`,
      });
    } else if (!KARPATHY_STAGE_ID_SET.has(stageId)) {
      missing.push({
        field: `steps[${index}].stage_id`,
        issue: 'invalid',
        question: `steps[${index}] stage_id는 ${KARPATHY_STAGE_IDS.join(', ')} 중 하나여야 합니다.`,
      });
    }

    if (assignee && goal && acceptanceCriteria && constraints && stageId) {
      preparedSteps.push({
        assignee,
        goal,
        acceptance_criteria: acceptanceCriteria,
        constraints,
        stage_id: stageId,
      });
    }
  });

  return { preparedTitle, preparedSteps, missing };
}

async function runWorkflowIntake(argsJson: string): Promise<string> {
  let args: {
    title?: string;
    steps?: unknown[];
  };
  try {
    args = JSON.parse(argsJson);
  } catch {
    return JSON.stringify({ ok: false, error: 'Invalid JSON' });
  }

  const { preparedTitle, preparedSteps, missing } =
    collectWorkflowIntakeMissingFields(args.title, args.steps);
  const ready =
    missing.length === 0 &&
    typeof preparedTitle === 'string' &&
    preparedSteps.length > 0;

  return JSON.stringify({
    ok: true,
    ready,
    flow: 'karpathy-loop',
    required_fields: [
      'title',
      'steps[].assignee',
      'steps[].goal',
      'steps[].acceptance_criteria',
      'steps[].constraints',
      'steps[].stage_id',
    ],
    missing,
    questions: missing.map((item) => item.question),
    prepared: ready
      ? {
          title: preparedTitle,
          steps: preparedSteps,
        }
      : undefined,
    next_action: ready
      ? 'Call start_workflow with prepared.title and prepared.steps'
      : 'Ask the user for missing fields and call workflow_intake again',
  });
}

async function runStartWorkflow(
  argsJson: string,
  ctx: ExecutorContext,
): Promise<string> {
  let args: {
    title: string;
    steps: Array<{
      assignee: string;
      goal: string;
      acceptance_criteria: string | string[];
      constraints: string | string[];
      stage_id: string;
    }>;
  };
  try {
    args = JSON.parse(argsJson);
  } catch {
    return JSON.stringify({ ok: false, error: 'Invalid JSON' });
  }
  if (!args.title?.trim()) {
    return JSON.stringify({ ok: false, error: 'title is required' });
  }
  if (!Array.isArray(args.steps) || args.steps.length === 0) {
    return JSON.stringify({ ok: false, error: 'steps must be a non-empty array' });
  }
  if (
    Object.prototype.hasOwnProperty.call(
      args as unknown as Record<string, unknown>,
      'flow_id',
    )
  ) {
    return JSON.stringify({
      ok: false,
      error: 'flow_id is no longer accepted; start_workflow always uses karpathy-loop',
    });
  }
  if (!ctx.chatJid) {
    return JSON.stringify({
      ok: false,
      error: 'chatJid is unavailable in this runtime; cannot start workflow',
    });
  }

  const sanitizedSteps: SanitizedWorkflowStep[] = [];
  for (let i = 0; i < args.steps.length; i++) {
    const parsed = sanitizeWorkflowStep(args.steps[i], i);
    if (!parsed.ok) {
      return JSON.stringify({ ok: false, error: parsed.error });
    }
    sanitizedSteps.push(parsed.step);
  }

  const workflowId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeIpcTask({
    type: 'start_workflow',
    workflowId,
    title: args.title.trim(),
    flowId: 'karpathy-loop',
    steps: sanitizedSteps,
    chatJid: ctx.chatJid,
    groupFolder: ctx.groupFolder,
    timestamp: new Date().toISOString(),
  });

  return JSON.stringify({
    ok: true,
    workflowId,
    message: `Workflow "${args.title.trim()}" request queued. Execution will start only after backend validation and confirmation.`,
  });
}

async function runReportResult(
  argsJson: string,
  ctx: ExecutorContext,
): Promise<string> {
  let args: {
    workflow_id: string;
    step_index: number;
    status: 'completed' | 'failed';
    result_summary: string;
  };
  try {
    args = JSON.parse(argsJson);
  } catch {
    return JSON.stringify({ ok: false, error: 'Invalid JSON' });
  }
  if (!args.workflow_id?.trim()) {
    return JSON.stringify({ ok: false, error: 'workflow_id is required' });
  }
  if (!Number.isInteger(args.step_index) || args.step_index < 0) {
    return JSON.stringify({ ok: false, error: 'step_index must be a non-negative integer' });
  }
  if (args.status !== 'completed' && args.status !== 'failed') {
    return JSON.stringify({ ok: false, error: 'status must be completed or failed' });
  }
  if (!args.result_summary?.trim()) {
    return JSON.stringify({ ok: false, error: 'result_summary is required' });
  }

  writeIpcTask({
    type: 'report_result',
    workflowId: args.workflow_id.trim(),
    stepIndex: args.step_index,
    status: args.status,
    resultSummary: args.result_summary.trim(),
    groupFolder: ctx.groupFolder,
    timestamp: new Date().toISOString(),
  });

  return JSON.stringify({
    ok: true,
    message: `Workflow ${args.workflow_id} step ${args.step_index} reported as ${args.status}.`,
  });
}

async function runCancelWorkflow(
  argsJson: string,
  ctx: ExecutorContext,
): Promise<string> {
  let args: { workflow_id: string };
  try {
    args = JSON.parse(argsJson);
  } catch {
    return JSON.stringify({ ok: false, error: 'Invalid JSON' });
  }
  if (!args.workflow_id?.trim()) {
    return JSON.stringify({ ok: false, error: 'workflow_id is required' });
  }

  writeIpcTask({
    type: 'cancel_workflow',
    workflowId: args.workflow_id.trim(),
    groupFolder: ctx.groupFolder,
    timestamp: new Date().toISOString(),
  });

  return JSON.stringify({
    ok: true,
    message: `Workflow ${args.workflow_id} cancellation requested.`,
  });
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
    case 'workflow_intake':
      return runWorkflowIntake(argsJson);
    case 'start_workflow':
      return runStartWorkflow(argsJson, ctx);
    case 'report_result':
      return runReportResult(argsJson, ctx);
    case 'cancel_workflow':
      return runCancelWorkflow(argsJson, ctx);

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
