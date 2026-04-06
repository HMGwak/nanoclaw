import { describe, expect, it } from 'vitest';

import { listFlowSpecs } from './index.js';

describe('catalog flow registry', () => {
  it('returns empty flow list when no flows are registered', () => {
    expect(listFlowSpecs()).toEqual([]);
  });
});
