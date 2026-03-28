import { AgentProvider } from '../types.js';
import { claudeProvider } from './claude.js';
import { opencodeProvider } from './opencode.js';
import { openaiCompatProvider } from './openai-compat.js';
import { openaiProvider } from './openai.js';

function hasValue(value: string | undefined): boolean {
  return Boolean(value && value.trim());
}

function detectDefaultProviderName(): string {
  if (hasValue(process.env.OPENAI_API_KEY)) return 'openai';
  if (hasValue(process.env.OPENCODE_API_KEY)) return 'opencode';
  if (
    hasValue(process.env.OPENAI_COMPAT_API_KEY) ||
    hasValue(process.env.ZAI_API_KEY)
  ) {
    return 'zai';
  }
  if (
    hasValue(process.env.ANTHROPIC_API_KEY) ||
    hasValue(process.env.CLAUDE_CODE_OAUTH_TOKEN)
  ) {
    return 'claude';
  }
  return 'openai';
}

export function getAgentProvider(name: string | undefined): AgentProvider {
  switch ((name || detectDefaultProviderName()).toLowerCase()) {
    case 'claude':
      return claudeProvider;
    case 'opencode':
      return opencodeProvider;
    case 'zai':
    case 'openai-compat':
      return openaiCompatProvider;
    case 'openai':
      return openaiProvider;
    default:
      throw new Error(
        `Unsupported NANOCLAW_AGENT_BACKEND "${name}". Expected "openai", "opencode", "zai", "openai-compat", or "claude".`,
      );
  }
}
