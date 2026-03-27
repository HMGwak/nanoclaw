import { AgentProvider } from '../types.js';
import { claudeProvider } from './claude.js';
import { opencodeProvider } from './opencode.js';
import { openaiCompatProvider } from './openai-compat.js';
import { openaiProvider } from './openai.js';

export function getAgentProvider(name: string | undefined): AgentProvider {
  switch ((name || 'claude').toLowerCase()) {
    case 'claude':
      return claudeProvider;
    case 'opencode':
      return opencodeProvider;
    case 'openai-compat':
      return openaiCompatProvider;
    case 'openai':
      return openaiProvider;
    default:
      throw new Error(
        `Unsupported NANOCLAW_AGENT_BACKEND "${name}". Expected "claude", "opencode", "openai-compat", or "openai".`,
      );
  }
}
