/**
 * OpenAI-Compatible Provider
 * Works with any API that supports the OpenAI /chat/completions format:
 * - Z.AI / GLM (api.z.ai)
 * - OpenRouter, Together AI, etc.
 *
 * Uses shared tool library from ../tools/shared.ts
 *
 * Env vars:
 *   OPENAI_COMPAT_API_KEY   — API key
 *   OPENAI_COMPAT_BASE_URL  — Base URL (default: https://api.z.ai/api/paas/v4/)
 *   OPENAI_COMPAT_MODEL     — Model name (default: glm-5)
 *   NANOCLAW_ALLOWED_TOOLS  — Comma-separated tool whitelist (optional)
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

import {
  AgentProvider,
  AgentTurnContext,
  AgentTurnResult,
} from '../types.js';
import { filterTools, executeTool } from '../tools/shared.js';

const DEFAULT_MODEL = 'glm-5';
const DEFAULT_BASE_URL = 'https://api.z.ai/api/paas/v4/';
const MAX_TOOL_LOOPS = 16;

const SESSION_STATE_DIR = '/home/node/.nanoclaw/openai-compat';

interface SessionState {
  history: { role: 'user' | 'assistant'; content: string }[];
}

function ensureStateDir(): void {
  fs.mkdirSync(SESSION_STATE_DIR, { recursive: true });
}

function loadSessionState(sessionId: string): SessionState {
  ensureStateDir();
  const filePath = path.join(SESSION_STATE_DIR, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) return { history: [] };
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SessionState;
  } catch {
    return { history: [] };
  }
}

function saveSessionState(sessionId: string, state: SessionState): void {
  ensureStateDir();
  fs.writeFileSync(
    path.join(SESSION_STATE_DIR, `${sessionId}.json`),
    JSON.stringify(state, null, 2) + '\n',
  );
}

function buildSystemPrompt(context: AgentTurnContext): string {
  const sections: string[] = [];

  const groupClaudeMdPath = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupClaudeMdPath)) {
    sections.push(fs.readFileSync(groupClaudeMdPath, 'utf-8').trim());
  } else {
    sections.push('You are an AI assistant. Use shell for local commands, web_fetch for known URLs, web_search for current information.');
  }

  const globalPath = '/workspace/global/CLAUDE.md';
  if (fs.existsSync(globalPath)) {
    sections.push(fs.readFileSync(globalPath, 'utf-8').trim());
  }

  return sections.join('\n\n');
}

async function runOpenAICompatTurn(
  context: AgentTurnContext,
): Promise<AgentTurnResult> {
  const sessionId = context.sessionId || crypto.randomUUID();
  const model = context.agentEnv.OPENAI_COMPAT_MODEL || DEFAULT_MODEL;
  const baseURL = context.agentEnv.OPENAI_COMPAT_BASE_URL || DEFAULT_BASE_URL;
  const apiKey = context.agentEnv.OPENAI_COMPAT_API_KEY || '';

  context.log(`OpenAI-compat turn (session: ${sessionId}, model: ${model}, baseURL: ${baseURL})`);

  if (!apiKey) {
    context.emitOutput({ status: 'error', result: null, error: 'OPENAI_COMPAT_API_KEY is not set' });
    return { closedDuringQuery: false };
  }

  // Tool filtering via env var
  const allowedToolsRaw = context.agentEnv.NANOCLAW_ALLOWED_TOOLS;
  const allowedTools = allowedToolsRaw ? allowedToolsRaw.split(',').map(t => t.trim()) : undefined;
  const tools = filterTools(allowedTools);

  context.log(`Tools available: ${tools.length} (filtered: ${!!allowedTools})`);

  try {
    const client = new OpenAI({ apiKey, baseURL });
    const state = loadSessionState(sessionId);
    const systemPrompt = buildSystemPrompt(context);

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];
    for (const turn of state.history) {
      messages.push({ role: turn.role, content: turn.content });
    }
    messages.push({ role: 'user', content: context.prompt });

    let assistantText = '';
    const execCtx = { log: context.log, env: context.agentEnv };

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      const completion = await client.chat.completions.create({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
      });

      const choice = completion.choices?.[0];
      if (!choice) throw new Error('No choices in response');

      context.log(`loop=${loop + 1} finish_reason=${choice.finish_reason}`);

      if (choice.message.content) {
        assistantText = choice.message.content;
      }

      if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) break;

      messages.push(choice.message);
      context.log(`${choice.message.tool_calls.length} tool call(s)`);

      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.type !== 'function') continue;
        const fn = toolCall.function;
        context.log(`  tool: ${fn.name}(${fn.arguments.slice(0, 100)})`);
        const output = await executeTool(fn.name, fn.arguments, execCtx);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: output,
        });
      }
    }

    // Save history (simplified type for compat providers)
    state.history.push({ role: 'user', content: context.prompt });
    if (assistantText) {
      state.history.push({ role: 'assistant', content: assistantText });
    }
    saveSessionState(sessionId, state);

    context.emitOutput({
      status: 'success',
      result: assistantText || null,
      newSessionId: sessionId,
    });

    return { newSessionId: sessionId, closedDuringQuery: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    context.log(`OpenAI-compat error: ${msg}`);
    context.emitOutput({ status: 'error', result: null, error: msg });
    return { closedDuringQuery: false };
  }
}

export const openaiCompatProvider: AgentProvider = {
  name: 'openai-compat',
  runTurn: runOpenAICompatTurn,
};
