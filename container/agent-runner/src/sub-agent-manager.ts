/**
 * SubAgentManager — manages secondary agents (team members) within a bot.
 *
 * The primary agent can delegate to secondary agents via the ask_agent MCP tool.
 * Each secondary agent is an OpenAI-compatible chat completion client with its
 * own optional tool allowlist.
 */

import OpenAI from 'openai';
import { ChildProcess, execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { promisify } from 'util';

import { runChatCompletionLoop } from './providers/chat-loop.js';
import { filterTools } from './tools/catalog.js';
import { SubAgentEntry } from './types.js';

const SUBAGENTS_CONFIG_PATH = '/home/node/.nanoclaw/subagents.json';
const execFileAsync = promisify(execFile);
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1/';
const DEFAULT_OPENAI_MODEL = 'gpt-4o';
const DEFAULT_OPENAI_COMPAT_BASE_URL = 'https://api.z.ai/api/paas/v4/';
const DEFAULT_OPENAI_COMPAT_MODEL = 'glm-5';
const DEFAULT_OPENCODE_MODEL = 'opencode-go/kimi-k2.5';
const OPENCODE_TIMEOUT_MS = 300_000;
const OPENCODE_MAX_OUTPUT = 200_000;
const OPENCODE_WORK_DIR = '/workspace/group';
const OPENCODE_EXPORT_TIMEOUT_MS = 5_000;
const OPENCODE_EXPORT_POLL_MS = 1_500;
const OPENCODE_EXPORT_IDLE_MS = 4_000;

interface AgentInfo {
  name: string;
  backend: string;
  model?: string;
  role?: string;
  systemPrompt?: string;
  allowedTools?: string[];
}

interface OpenAITransportRuntime {
  transport: 'openai';
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface OpencodeTransportRuntime {
  transport: 'opencode';
  apiKey: string;
  model: string;
}

type ResolvedSubAgentRuntime =
  | OpenAITransportRuntime
  | OpencodeTransportRuntime;

interface PreparedAgent {
  entry: SubAgentEntry;
  model: string;
  transport: ResolvedSubAgentRuntime['transport'];
  client?: OpenAI;
  apiKey?: string;
}

interface OpencodeRunOutput {
  text: string;
  error?: string;
}

interface OpencodeEvent {
  type?: string;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    reason?: string;
    tokens?: {
      input?: number;
      output?: number;
    };
  };
  error?: {
    message?: string;
    data?: {
      message?: string;
    };
  };
}

interface ExecFileErrorShape extends Error {
  code?: string | number | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

function readStringEnv(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function resolveSubAgentRuntime(
  entry: SubAgentEntry,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSubAgentRuntime {
  switch (entry.backend) {
    case 'openai':
      return {
        transport: 'openai',
        apiKey: entry.apiKey || readStringEnv(env, 'OPENAI_API_KEY') || 'dummy',
        baseUrl:
          entry.baseUrl ||
          readStringEnv(env, 'OPENAI_BASE_URL') ||
          DEFAULT_OPENAI_BASE_URL,
        model:
          entry.model ||
          readStringEnv(env, 'OPENAI_MODEL') ||
          DEFAULT_OPENAI_MODEL,
      };
    case 'openai-compat':
    case 'zai':
      return {
        transport: 'openai',
        apiKey:
          entry.apiKey ||
          readStringEnv(env, 'OPENAI_COMPAT_API_KEY') ||
          readStringEnv(env, 'ZAI_API_KEY') ||
          'dummy',
        baseUrl:
          entry.baseUrl ||
          readStringEnv(env, 'OPENAI_COMPAT_BASE_URL') ||
          DEFAULT_OPENAI_COMPAT_BASE_URL,
        model:
          entry.model ||
          readStringEnv(env, 'OPENAI_COMPAT_MODEL') ||
          readStringEnv(env, 'ZAI_MODEL') ||
          DEFAULT_OPENAI_COMPAT_MODEL,
      };
    case 'opencode':
      return {
        transport: 'opencode',
        apiKey:
          entry.apiKey || readStringEnv(env, 'OPENCODE_API_KEY') || 'dummy',
        model:
          entry.model ||
          readStringEnv(env, 'OPENCODE_MODEL') ||
          DEFAULT_OPENCODE_MODEL,
      };
    default:
      return {
        transport: 'openai',
        apiKey: entry.apiKey || readStringEnv(env, 'OPENAI_API_KEY') || 'dummy',
        baseUrl:
          entry.baseUrl ||
          readStringEnv(env, 'OPENAI_BASE_URL') ||
          DEFAULT_OPENAI_BASE_URL,
        model:
          entry.model ||
          readStringEnv(env, 'OPENAI_MODEL') ||
          DEFAULT_OPENAI_MODEL,
      };
  }
}

export function parseOpencodeJsonOutput(stdout: string): OpencodeRunOutput {
  let resultText = '';
  let errorText: string | undefined;

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        part?: { text?: string };
        error?: {
          message?: string;
          data?: { message?: string };
        };
      };
      if (event.type === 'text' && event.part?.text) {
        resultText += event.part.text;
        continue;
      }
      if (event.type === 'error') {
        errorText =
          event.error?.data?.message ||
          event.error?.message ||
          'OpenCode returned an error event.';
      }
    } catch {
      /* ignore non-JSON lines */
    }
  }

  return { text: resultText.trim(), error: errorText };
}

function parseOpencodeEventLine(line: string): OpencodeEvent | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as OpencodeEvent;
  } catch {
    return null;
  }
}

export function isOpencodeFinalStepFinish(event: OpencodeEvent): boolean {
  return (
    event.type === 'step_finish' &&
    event.part?.reason !== 'tool-calls' &&
    event.part?.reason !== 'tool_calls'
  );
}

export function parseOpencodeExport(stdout: string): OpencodeRunOutput | null {
  const jsonStart = stdout.indexOf('{');
  if (jsonStart < 0) return null;

  try {
    const payload = JSON.parse(stdout.slice(jsonStart)) as {
      messages?: Array<{
        info?: {
          role?: string;
          time?: {
            completed?: number;
          };
        };
        parts?: Array<{
          type?: string;
          text?: string;
        }>;
      }>;
    };

    const assistantMessages = (payload.messages || []).filter(
      (message) => message.info?.role === 'assistant',
    );
    if (assistantMessages.length === 0) return null;

    const completedAssistant =
      [...assistantMessages]
        .reverse()
        .find((message) => Boolean(message.info?.time?.completed)) ||
      assistantMessages[assistantMessages.length - 1];
    if (!completedAssistant) return null;

    const text = (completedAssistant.parts || [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text || '')
      .join('')
      .trim();

    return { text };
  } catch {
    return null;
  }
}

function formatExecFileOutput(value: string | Buffer | undefined): string {
  if (!value) return '';
  return String(value).trim().slice(0, 4000);
}

function buildOpencodeFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return `OpenCode sub-agent failed: ${String(error)}`;
  }

  const details = error as ExecFileErrorShape;
  const lines = [`OpenCode sub-agent failed: ${details.message}`];
  if (details.code != null) lines.push(`code: ${details.code}`);
  if (details.signal) lines.push(`signal: ${details.signal}`);
  if (details.killed) lines.push('killed: true');

  const stderr = formatExecFileOutput(details.stderr);
  if (stderr) lines.push(`stderr:\n${stderr}`);

  const stdout = formatExecFileOutput(details.stdout);
  if (stdout) lines.push(`stdout:\n${stdout}`);

  return lines.join('\n\n');
}

function tryKillProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): boolean {
  if (child.pid == null) return false;

  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
    return true;
  } catch {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

export class SubAgentManager {
  private agents: Map<string, PreparedAgent> = new Map();

  constructor(subAgents: SubAgentEntry[]) {
    for (const entry of subAgents) {
      this.agents.set(entry.name, this.createAgent(entry));
    }
  }

  private createAgent(entry: SubAgentEntry): PreparedAgent {
    const runtime = resolveSubAgentRuntime(entry);

    if (runtime.transport === 'opencode') {
      return {
        entry,
        transport: 'opencode',
        model: runtime.model,
        apiKey: runtime.apiKey,
      };
    }

    return {
      entry,
      transport: 'openai',
      client: new OpenAI({
        apiKey: runtime.apiKey,
        baseURL: runtime.baseUrl,
      }),
      model: runtime.model,
    };
  }

  private buildSystemPrompt(
    entry: SubAgentEntry,
    systemPrompt?: string,
  ): string | undefined {
    const systemParts: string[] = [];
    if (entry.role) {
      systemParts.push(`You are ${entry.role}.`);
    }
    if (entry.systemPrompt) {
      systemParts.push(entry.systemPrompt);
    }
    if (systemPrompt) {
      systemParts.push(systemPrompt);
    }
    return systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
  }

  private async askOpenAIAgent(
    agent: PreparedAgent,
    prompt: string,
    systemPrompt?: string,
  ): Promise<string> {
    if (!agent.client) {
      throw new Error(`Sub-agent "${agent.entry.name}" has no OpenAI client`);
    }

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    const resolvedSystemPrompt = this.buildSystemPrompt(
      agent.entry,
      systemPrompt,
    );
    if (resolvedSystemPrompt) {
      messages.push({ role: 'system', content: resolvedSystemPrompt });
    }

    messages.push({ role: 'user', content: prompt });

    const tools = agent.entry.allowedTools
      ? filterTools(agent.entry.allowedTools)
      : [];
    const response = await runChatCompletionLoop({
      client: agent.client,
      model: agent.model,
      messages,
      tools,
      loopContext: {
        log: () => {
          /* sub-agent tool logs are intentionally quiet */
        },
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
      },
      maxLoops: 16,
    });

    return response || '(no response)';
  }

  private async askOpencodeAgent(
    agent: PreparedAgent,
    prompt: string,
    systemPrompt?: string,
  ): Promise<string> {
    const apiKey =
      agent.apiKey || readStringEnv(process.env, 'OPENCODE_API_KEY');
    if (!apiKey) {
      throw new Error('OPENCODE_API_KEY is not set for sub-agent execution');
    }

    const env: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    env.OPENCODE_API_KEY = apiKey;

    const resolvedSystemPrompt = this.buildSystemPrompt(
      agent.entry,
      systemPrompt,
    );
    const finalPrompt = [
      resolvedSystemPrompt
        ? ['System instructions:', resolvedSystemPrompt].join('\n')
        : null,
      ['User task:', prompt].join('\n'),
    ]
      .filter((part): part is string => Boolean(part))
      .join('\n\n');

    const cwd = fs.existsSync(OPENCODE_WORK_DIR)
      ? OPENCODE_WORK_DIR
      : process.cwd();
    let lastFailure: unknown = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await new Promise<string>((resolve, reject) => {
          const child = spawn(
            'opencode',
            [
              'run',
              '--format',
              'json',
              '--print-logs',
              '--log-level',
              'INFO',
              '--model',
              agent.model,
              finalPrompt,
            ],
            {
              cwd,
              env,
              detached: process.platform !== 'win32',
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );

          child.stdout?.setEncoding('utf8');
          child.stderr?.setEncoding('utf8');

          const stdoutLines = readline.createInterface({
            input: child.stdout!,
            crlfDelay: Infinity,
          });
          const stderrLines = readline.createInterface({
            input: child.stderr!,
            crlfDelay: Infinity,
          });

          let stdoutRaw = '';
          let stderrRaw = '';
          let resultText = '';
          let errorText: string | undefined;
          let sawStepFinish = false;
          let sessionId: string | undefined;
          let exportInFlight = false;
          let lastActivityAt = Date.now();
          let settled = false;
          let exportPollTimer: NodeJS.Timeout | null = null;
          let forceKillTimer: NodeJS.Timeout | null = null;
          let overallTimeout: NodeJS.Timeout | null = null;

          const finish = (handler: () => void): void => {
            if (settled) return;
            settled = true;
            if (overallTimeout) clearTimeout(overallTimeout);
            if (exportPollTimer) clearInterval(exportPollTimer);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            stdoutLines.close();
            stderrLines.close();
            handler();
          };

          const requestStop = (): void => {
            if (forceKillTimer) return;
            tryKillProcessGroup(child, 'SIGTERM');
            forceKillTimer = setTimeout(() => {
              tryKillProcessGroup(child, 'SIGKILL');
            }, 1000);
          };

          stdoutLines.on('line', (line) => {
            lastActivityAt = Date.now();
            stdoutRaw += `${line}\n`;
            const event = parseOpencodeEventLine(line);
            if (!event) return;

            if (event.type === 'text' && event.part?.text) {
              resultText += event.part.text;
              return;
            }

            if (event.type === 'error') {
              errorText =
                event.error?.data?.message ||
                event.error?.message ||
                'OpenCode returned an error event.';
              return;
            }

            if (isOpencodeFinalStepFinish(event)) {
              sawStepFinish = true;
              requestStop();
            }
          });

          stderrLines.on('line', (line) => {
            lastActivityAt = Date.now();
            stderrRaw += `${line}\n`;
            const sessionMatch = line.match(/service=session id=(\S+)/);
            if (sessionMatch) {
              sessionId = sessionMatch[1];
            }
          });

          child.on('error', (error) => {
            finish(() => reject(error));
          });

          child.on('close', (code, signal) => {
            const parsed = parseOpencodeJsonOutput(stdoutRaw);
            const finalText = (resultText || parsed.text).trim();
            const finalError = errorText || parsed.error;

            if (sawStepFinish) {
              finish(() => {
                if (finalError && !finalText) {
                  reject(new Error(finalError));
                  return;
                }
                if (finalText) {
                  resolve(finalText);
                  return;
                }
                reject(new Error('OpenCode returned no text output.'));
              });
              return;
            }

            if (finalError) {
              finish(() => reject(new Error(finalError)));
              return;
            }

            const exitError = new Error(
              `OpenCode exited before completion (code: ${code ?? 'null'}, signal: ${signal ?? 'null'})`,
            ) as ExecFileErrorShape;
            exitError.code = code;
            exitError.signal = signal;
            exitError.stdout = stdoutRaw;
            exitError.stderr = stderrRaw;
            finish(() => reject(exitError));
          });

          overallTimeout = setTimeout(() => {
            requestStop();
            const timeoutError = new Error(
              `OpenCode timed out after ${OPENCODE_TIMEOUT_MS}ms`,
            ) as ExecFileErrorShape;
            timeoutError.killed = true;
            timeoutError.stdout = stdoutRaw;
            timeoutError.stderr = stderrRaw;
            finish(() => reject(timeoutError));
          }, OPENCODE_TIMEOUT_MS);

          exportPollTimer = setInterval(async () => {
            if (
              settled ||
              sawStepFinish ||
              exportInFlight ||
              !sessionId ||
              Date.now() - lastActivityAt < OPENCODE_EXPORT_IDLE_MS
            ) {
              return;
            }

            exportInFlight = true;
            try {
              const { stdout } = await execFileAsync(
                'opencode',
                ['export', sessionId],
                {
                  cwd,
                  env,
                  timeout: OPENCODE_EXPORT_TIMEOUT_MS,
                  maxBuffer: OPENCODE_MAX_OUTPUT * 2,
                },
              );
              const exported = parseOpencodeExport(stdout);
              if (exported?.text) {
                resultText = exported.text;
                sawStepFinish = true;
                requestStop();
              }
            } catch {
              /* ignore transient export failures while the session is still running */
            } finally {
              exportInFlight = false;
            }
          }, OPENCODE_EXPORT_POLL_MS);
        });

        if (response) return response;

        lastFailure = new Error('OpenCode returned no text output.');
        if (attempt < 2) continue;
        throw lastFailure;
      } catch (error) {
        lastFailure = error;
        if (attempt < 2) continue;
      }
    }

    throw new Error(buildOpencodeFailureMessage(lastFailure));
  }

  /**
   * Ask a secondary agent a question and get a text response.
   * Tool access is controlled by the agent's own allowlist.
   */
  async askAgent(
    name: string,
    prompt: string,
    systemPrompt?: string,
  ): Promise<string> {
    const agent = this.agents.get(name);
    if (!agent) {
      const available = this.listAgents()
        .map((a) => a.name)
        .join(', ');
      throw new Error(
        `Sub-agent "${name}" not found. Available: ${available || 'none'}`,
      );
    }

    if (agent.transport === 'opencode') {
      return this.askOpencodeAgent(agent, prompt, systemPrompt);
    }

    return this.askOpenAIAgent(agent, prompt, systemPrompt);
  }

  /** List available sub-agents with their metadata. */
  listAgents(): AgentInfo[] {
    return Array.from(this.agents.values()).map(({ entry }) => ({
      name: entry.name,
      backend: entry.backend,
      model: entry.model,
      role: entry.role,
      systemPrompt: entry.systemPrompt,
      allowedTools: entry.allowedTools,
    }));
  }

  hasAgent(name: string): boolean {
    return this.agents.has(name);
  }

  get size(): number {
    return this.agents.size;
  }
}

/**
 * Load SubAgentManager from the config file written by agent-runner at startup.
 * Returns null if no sub-agents are configured.
 */
export function loadSubAgentManager(): SubAgentManager | null {
  try {
    if (!fs.existsSync(SUBAGENTS_CONFIG_PATH)) return null;
    const data = JSON.parse(
      fs.readFileSync(SUBAGENTS_CONFIG_PATH, 'utf-8'),
    ) as SubAgentEntry[];
    if (!Array.isArray(data) || data.length === 0) return null;
    return new SubAgentManager(data);
  } catch {
    return null;
  }
}

/** Write sub-agent config to a known path for the MCP server to read. */
export function writeSubAgentConfig(subAgents: SubAgentEntry[]): void {
  const dir = path.dirname(SUBAGENTS_CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SUBAGENTS_CONFIG_PATH, JSON.stringify(subAgents, null, 2));
}
