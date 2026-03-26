import { readEnvFile } from './env.js';

export type AgentBackend = 'claude' | 'opencode';

export interface AgentBackendConfig {
  backend: AgentBackend;
  model?: string;
  upstreamBaseUrl: string;
  containerBaseUrlEnvVar: 'ANTHROPIC_BASE_URL';
  containerCredentialEnvVar:
    | 'ANTHROPIC_API_KEY'
    | 'CLAUDE_CODE_OAUTH_TOKEN';
  authMode: 'api-key' | 'oauth';
  /** OpenCode-specific: API key passed directly to container (no proxy needed). */
  opencodeApiKey?: string;
  /** OpenCode-specific: model identifier (e.g. "opencode-go/kimi-k2.5"). */
  opencodeModel?: string;
}

export function getAgentBackendConfig(): AgentBackendConfig {
  const env = readEnvFile([
    'AGENT_BACKEND',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OPENCODE_API_KEY',
    'OPENCODE_MODEL',
  ]);

  const requestedBackend = (
    process.env.AGENT_BACKEND ||
    env.AGENT_BACKEND ||
    'claude'
  ).toLowerCase();

  if (requestedBackend === 'opencode') {
    return {
      backend: 'opencode',
      upstreamBaseUrl: '',
      containerBaseUrlEnvVar: 'ANTHROPIC_BASE_URL',
      containerCredentialEnvVar: 'ANTHROPIC_API_KEY',
      authMode: 'api-key',
      opencodeApiKey:
        process.env.OPENCODE_API_KEY || env.OPENCODE_API_KEY,
      opencodeModel:
        process.env.OPENCODE_MODEL || env.OPENCODE_MODEL,
    };
  }

  if (requestedBackend !== 'claude') {
    throw new Error(
      `Unsupported AGENT_BACKEND "${requestedBackend}". Expected "claude" or "opencode".`,
    );
  }

  return {
    backend: 'claude',
    upstreamBaseUrl:
      process.env.ANTHROPIC_BASE_URL ||
      env.ANTHROPIC_BASE_URL ||
      'https://api.anthropic.com',
    containerBaseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    containerCredentialEnvVar:
      process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY
        ? 'ANTHROPIC_API_KEY'
        : 'CLAUDE_CODE_OAUTH_TOKEN',
    authMode:
      process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY
        ? 'api-key'
        : 'oauth',
  };
}
