import { describe, expect, it } from 'vitest';

import { getSdkProfileSpec, listSdkProfileSpecs } from './index.js';

describe('sdk profile registry', () => {
  it('lists legacy and local mlx profiles', () => {
    const profiles = listSdkProfileSpecs();
    const ids = profiles.map((profile) => profile.id);

    expect(ids).toContain('openai_gpt54');
    expect(ids).toContain('local_mlx_gemma4_26b');
    expect(ids).toContain('local_mlx_gemma4_e4b');
    expect(ids).toContain('local_mlx_qwen35_9b');
  });

  it('returns local mlx profile details', () => {
    const profile = getSdkProfileSpec('local_mlx_gemma4_26b');
    expect(profile).not.toBeNull();
    expect(profile!.backend).toBe('openai');
    expect(profile!.model).toBe('default_model');
    expect(profile!.baseUrl).toBe('http://host.docker.internal:18081/v1');
  });

  it('returns null for unknown profile id', () => {
    expect(getSdkProfileSpec('unknown-profile')).toBeNull();
  });
});
