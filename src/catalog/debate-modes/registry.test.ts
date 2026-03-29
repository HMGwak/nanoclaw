import { describe, expect, it } from 'vitest';

import {
  getDebateModeSpec,
  listDebateModeSpecs,
  listDebateProtocolSpecs,
} from './index.js';

describe('debate-modes compatibility exports', () => {
  it('keeps legacy debate-modes imports working', () => {
    expect(listDebateModeSpecs()).toHaveLength(7);
    expect(listDebateProtocolSpecs()).toHaveLength(7);
    expect(getDebateModeSpec('standard')?.protocolId).toBe('standard');
  });
});
