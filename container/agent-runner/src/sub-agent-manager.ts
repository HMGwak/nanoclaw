/**
 * SubAgentManager — manages secondary agents (team members) within a bot.
 *
 * The primary agent can delegate to secondary agents via the ask_agent MCP tool.
 * Each secondary agent is an OpenAI-compatible chat completion client with its
 * own optional tool allowlist.
 */

import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';

import { runChatCompletionLoop } from './providers/chat-loop.js';
import { filterTools } from './tools/catalog.js';
import { SubAgentEntry } from './types.js';

const SUBAGENTS_CONFIG_PATH = '/home/node/.nanoclaw/subagents.json';

interface AgentInfo {
  name: string;
  backend: string;
  model?: string;
  role?: string;
  allowedTools?: string[];
}

export class SubAgentManager {
  private agents: Map<
    string,
    { entry: SubAgentEntry; client: OpenAI; model: string }
  > = new Map();

  constructor(subAgents: SubAgentEntry[]) {
    for (const entry of subAgents) {
      const { client, model } = this.createClient(entry);
      this.agents.set(entry.name, { entry, client, model });
    }
  }

  private createClient(entry: SubAgentEntry): {
    client: OpenAI;
    model: string;
  } {
    switch (entry.backend) {
      case 'openai':
        return {
          client: new OpenAI({
            apiKey: entry.apiKey || 'dummy',
            baseURL: entry.baseUrl || 'https://api.openai.com/v1/',
          }),
          model: entry.model || 'gpt-4o',
        };
      case 'openai-compat':
      case 'zai':
        return {
          client: new OpenAI({
            apiKey: entry.apiKey || 'dummy',
            baseURL: entry.baseUrl || 'https://api.z.ai/api/paas/v4/',
          }),
          model: entry.model || 'glm-5',
        };
      case 'opencode':
        // OpenCode uses OpenAI-compatible API under the hood
        return {
          client: new OpenAI({
            apiKey: entry.apiKey || 'dummy',
            baseURL: entry.baseUrl || 'https://api.openai.com/v1/',
          }),
          model: entry.model || 'kimi-k2.5',
        };
      default:
        // Fallback: treat as openai-compat
        return {
          client: new OpenAI({
            apiKey: entry.apiKey || 'dummy',
            baseURL: entry.baseUrl || 'https://api.openai.com/v1/',
          }),
          model: entry.model || 'gpt-4o',
        };
    }
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

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    // Build system prompt from role + optional custom system prompt
    const systemParts: string[] = [];
    if (agent.entry.role) {
      systemParts.push(`You are ${agent.entry.role}.`);
    }
    if (systemPrompt) {
      systemParts.push(systemPrompt);
    }
    if (systemParts.length > 0) {
      messages.push({ role: 'system', content: systemParts.join('\n\n') });
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

  /** List available sub-agents with their metadata. */
  listAgents(): AgentInfo[] {
    return Array.from(this.agents.values()).map(({ entry }) => ({
      name: entry.name,
      backend: entry.backend,
      model: entry.model,
      role: entry.role,
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
