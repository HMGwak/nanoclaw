import { describe, expect, it } from 'vitest';

import { KARPATHY_LOOP_FLOW } from './index.js';

describe('karpathy-loop flow', () => {
  it('defines the reusable karpathy-loop flow stages', () => {
    expect(KARPATHY_LOOP_FLOW.id).toBe('karpathy-loop');
    expect(KARPATHY_LOOP_FLOW.stages.map((stage) => stage.id)).toEqual([
      'baseline',
      'change',
      'run',
      'verify',
      'decide',
      'collect',
      'report',
    ]);
  });
});
