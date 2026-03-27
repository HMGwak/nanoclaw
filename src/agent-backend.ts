import { readEnvFile } from './env.js';

export type AgentBackend = 'claude' | 'opencode' | 'openai-compat' | 'openai';

export interface AgentBackendConfig {
  backend: AgentBackend;
  model?: string;
  upstreamBaseUrl: string;
  containerBaseUrlEnvVar: 'ANTHROPIC_BASE_URL';
  containerCredentialEnvVar: 'ANTHROPIC_API_KEY' | 'CLAUDE_CODE_OAUTH_TOKEN';
  authMode: 'api-key' | 'oauth';
  /** OpenCode-specific: API key passed directly to container (no proxy needed). */
  opencodeApiKey?: string;
  /** OpenCode-specific: model identifier (e.g. "opencode-go/kimi-k2.5"). */
  opencodeModel?: string;
  /** OpenAI-compat: API key, base URL, model for any OpenAI-compatible API. */
  openaiCompatApiKey?: string;
  openaiCompatBaseUrl?: string;
  openaiCompatModel?: string;
  /** OpenAI-native: API key, base URL, model for OpenAI API. */
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiModel?: string;
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
    'ZAI_API_KEY',
    'ZAI_MODEL',
    'OPENAI_COMPAT_API_KEY',
    'OPENAI_COMPAT_BASE_URL',
    'OPENAI_COMPAT_MODEL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_MODEL',
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
      opencodeApiKey: process.env.OPENCODE_API_KEY || env.OPENCODE_API_KEY,
      opencodeModel: process.env.OPENCODE_MODEL || env.OPENCODE_MODEL,
    };
  }

  if (requestedBackend === 'openai-compat') {
    return {
      backend: 'openai-compat',
      upstreamBaseUrl: '',
      containerBaseUrlEnvVar: 'ANTHROPIC_BASE_URL',
      containerCredentialEnvVar: 'ANTHROPIC_API_KEY',
      authMode: 'api-key',
      openaiCompatApiKey:
        process.env.OPENAI_COMPAT_API_KEY ||
        env.OPENAI_COMPAT_API_KEY ||
        process.env.ZAI_API_KEY ||
        env.ZAI_API_KEY,
      openaiCompatBaseUrl:
        process.env.OPENAI_COMPAT_BASE_URL ||
        env.OPENAI_COMPAT_BASE_URL ||
        'https://api.z.ai/api/paas/v4/',
      openaiCompatModel:
        process.env.OPENAI_COMPAT_MODEL ||
        env.OPENAI_COMPAT_MODEL ||
        process.env.ZAI_MODEL ||
        env.ZAI_MODEL ||
        'glm-5',
    };
  }

  if (requestedBackend === 'openai') {
    return {
      backend: 'openai',
      upstreamBaseUrl: '',
      containerBaseUrlEnvVar: 'ANTHROPIC_BASE_URL',
      containerCredentialEnvVar: 'ANTHROPIC_API_KEY',
      authMode: 'api-key',
      openaiApiKey: process.env.OPENAI_API_KEY || env.OPENAI_API_KEY,
      openaiBaseUrl: process.env.OPENAI_BASE_URL || env.OPENAI_BASE_URL,
      openaiModel: process.env.OPENAI_MODEL || env.OPENAI_MODEL,
    };
  }

  if (requestedBackend !== 'claude') {
    throw new Error(
      `Unsupported AGENT_BACKEND "${requestedBackend}". Expected "claude", "opencode", "openai-compat", or "openai".`,
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
