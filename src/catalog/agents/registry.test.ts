import { describe, expect, it } from 'vitest';

import { getAgentSpec, listAgentSpecs } from './index.js';

describe('agent registry', () => {
  it('lists legacy and local mlx agents', () => {
    const agents = listAgentSpecs();
    const ids = agents.map((agent) => agent.id);

    expect(ids).toContain('openai_gpt54_planner');
    expect(ids).toContain('local_mlx_gemma4_26b_generalist');
    expect(ids).toContain('local_mlx_gemma4_e4b_generalist');
    expect(ids).toContain('local_mlx_qwen35_9b_generalist');
  });

  it('returns local mlx agent details', () => {
    const agent = getAgentSpec('local_mlx_qwen35_9b_generalist');
    expect(agent).not.toBeNull();
    expect(agent!.baseProfileId).toBe('local_mlx_qwen35_9b');
    expect(agent!.defaultToolsetIds).toEqual(['global_general_cli']);
  });

  it('returns null for unknown agent id', () => {
    expect(getAgentSpec('unknown-agent')).toBeNull();
  });
});
