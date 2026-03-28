import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnvFile = vi.hoisted(() => ({
  values: {} as Record<string, string>,
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => mockEnvFile.values),
}));

describe('getAgentBackendConfig', () => {
  beforeEach(() => {
    mockEnvFile.values = {};
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to openai when no backend is configured', async () => {
    const { getAgentBackendConfig } = await import('./agent-backend.js');

    expect(getAgentBackendConfig().backend).toBe('openai');
  });

  it('auto-selects openai when OPENAI_API_KEY exists', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
    const { getAgentBackendConfig } = await import('./agent-backend.js');

    expect(getAgentBackendConfig().backend).toBe('openai');
  });

  it('auto-selects opencode when only OPENCODE_API_KEY exists', async () => {
    vi.stubEnv('OPENCODE_API_KEY', 'opencode-test');
    const { getAgentBackendConfig } = await import('./agent-backend.js');

    expect(getAgentBackendConfig().backend).toBe('opencode');
  });

  it('auto-selects zai when only ZAI_API_KEY exists', async () => {
    vi.stubEnv('ZAI_API_KEY', 'zai-test');
    const { getAgentBackendConfig } = await import('./agent-backend.js');

    expect(getAgentBackendConfig().backend).toBe('zai');
  });

  it('falls back to claude when only Anthropic credentials exist', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    const { getAgentBackendConfig } = await import('./agent-backend.js');

    expect(getAgentBackendConfig().backend).toBe('claude');
  });

  it('accepts zai as an explicit backend alias', async () => {
    vi.stubEnv('AGENT_BACKEND', 'zai');
    vi.stubEnv('ZAI_API_KEY', 'zai-test');
    const { getAgentBackendConfig } = await import('./agent-backend.js');

    const config = getAgentBackendConfig();
    expect(config.backend).toBe('zai');
    expect(config.openaiCompatModel).toBe('glm-5');
  });
});
