import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  enforceContainerOnlyRuntime,
  hasContainerMarker,
} from './runtime-mode.js';

describe('runtime mode', () => {
  afterEach(() => {
    delete process.env.NANOCLAW_RUNTIME;
    delete process.env.NANOCLAW_ALLOW_HOST_RUNTIME;
    vi.unstubAllEnvs();
  });

  it('detects common container markers in cgroup text', () => {
    expect(hasContainerMarker('12:memory:/docker/abc123')).toBe(true);
    expect(hasContainerMarker('12:cpu:/kubepods/burstable/pod123')).toBe(true);
    expect(hasContainerMarker('12:cpu:/user.slice/user-501.slice')).toBe(false);
  });

  it('allows explicit host-runtime override', () => {
    vi.stubEnv('NANOCLAW_ALLOW_HOST_RUNTIME', '1');
    expect(() => enforceContainerOnlyRuntime()).not.toThrow();
  });

  it('allows explicit docker runtime env', () => {
    vi.stubEnv('NANOCLAW_RUNTIME', 'docker');
    expect(() => enforceContainerOnlyRuntime()).not.toThrow();
  });
});
