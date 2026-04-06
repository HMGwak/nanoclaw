import { describe, expect, it } from 'vitest';

import { formatAgentFailureNotice } from './agent-failure.js';

describe('formatAgentFailureNotice', () => {
  it('returns timeout-specific guidance for timed out errors', () => {
    expect(
      formatAgentFailureNotice(
        'Chat completion timed out after 30000ms (loop 1/16)',
      ),
    ).toContain('응답 시간이 초과');
  });

  it('returns a generic failure notice for other errors', () => {
    expect(formatAgentFailureNotice('unexpected provider error')).toBe(
      '요청을 처리하는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    );
  });
});
