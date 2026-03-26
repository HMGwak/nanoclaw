import { AgentProvider } from '../types.js';
import { claudeProvider } from './claude.js';
import { opencodeProvider } from './opencode.js';

export function getAgentProvider(name: string | undefined): AgentProvider {
  switch ((name || 'claude').toLowerCase()) {
    case 'claude':
      return claudeProvider;
    case 'opencode':
      return opencodeProvider;
    default:
      throw new Error(
        `Unsupported NANOCLAW_AGENT_BACKEND "${name}". Expected "claude" or "opencode".`,
      );
  }
}
