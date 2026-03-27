/**
 * OpenAI Provider
 * Dedicated provider for OpenAI API (api.openai.com).
 * Supports API key auth and OAuth proxy (openai-oauth).
 *
 * Uses shared tool library from ../tools/shared.ts
 *
 * Env vars:
 *   OPENAI_API_KEY       — API key (sk-...) or dummy for OAuth proxy
 *   OPENAI_BASE_URL      — Base URL (default: https://api.openai.com/v1/)
 *   OPENAI_MODEL         — Model name (default: gpt-4o)
 *   NANOCLAW_ALLOWED_TOOLS — Comma-separated tool whitelist (optional)
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

const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1/';
const MAX_TOOL_LOOPS = 24;

const SESSION_STATE_DIR = '/home/node/.nanoclaw/openai';

interface SessionState {
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
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
    sections.push('You are an AI assistant with browser automation tools.');
  }

  const globalPath = '/workspace/global/CLAUDE.md';
  if (fs.existsSync(globalPath)) {
    sections.push(fs.readFileSync(globalPath, 'utf-8').trim());
  }

  sections.push(
    `Current group: ${context.containerInput.groupFolder}`,
    `Chat JID: ${context.containerInput.chatJid}`,
    `Is main: ${context.containerInput.isMain}`,
  );

  return sections.join('\n\n');
}

async function runOpenAITurn(
  context: AgentTurnContext,
): Promise<AgentTurnResult> {
  const sessionId = context.sessionId || crypto.randomUUID();
  const model = context.agentEnv.OPENAI_MODEL || DEFAULT_MODEL;
  const baseURL = context.agentEnv.OPENAI_BASE_URL || DEFAULT_BASE_URL;
  const apiKey = context.agentEnv.OPENAI_API_KEY || '';

  context.log(
    `OpenAI turn (session: ${sessionId}, model: ${model}, baseURL: ${baseURL})`,
  );

  if (!apiKey) {
    context.emitOutput({
      status: 'error',
      result: null,
      error: 'OPENAI_API_KEY is not set.',
    });
    return { closedDuringQuery: false };
  }

  // Tool filtering via env var (set by container-runner from containerConfig.allowedTools)
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
      ...state.history,
      { role: 'user', content: context.prompt },
    ];

    let assistantText = '';
    const execCtx = { log: context.log, env: context.agentEnv };

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      const completion = await client.chat.completions.create({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
      });

      const choice = completion.choices?.[0];
      if (!choice) throw new Error('No choices in completion response');

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

    // Save history
    state.history.push({ role: 'user', content: context.prompt });
    if (assistantText) {
      state.history.push({ role: 'assistant', content: assistantText });
    }
    const MAX_HISTORY_TURNS = 100;
    if (state.history.length > MAX_HISTORY_TURNS) {
      state.history = state.history.slice(-MAX_HISTORY_TURNS);
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
    context.log(`OpenAI error: ${msg}`);
    context.emitOutput({ status: 'error', result: null, error: msg });
    return { closedDuringQuery: false };
  }
}

export const openaiProvider: AgentProvider = {
  name: 'openai',
  runTurn: runOpenAITurn,
};
