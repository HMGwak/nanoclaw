import { describe, expect, it } from 'vitest';

import { getFlowSpec, listFlowSpecs } from './index.js';

describe('catalog flow registry', () => {
  it('lists registered flows', () => {
    const flows = listFlowSpecs();
    expect(flows.length).toBeGreaterThanOrEqual(1);
    expect(flows.some((f) => f.id === 'karpathy-loop')).toBe(true);
  });

  it('returns karpathy-loop flow spec with execute stage', () => {
    const flow = getFlowSpec('karpathy-loop');
    expect(flow).not.toBeNull();
    expect(flow!.stages).toHaveLength(1);
    expect(flow!.stages[0].id).toBe('execute');
  });

  it('returns null for unknown flow id', () => {
    expect(getFlowSpec('nonexistent')).toBeNull();
  });
});
