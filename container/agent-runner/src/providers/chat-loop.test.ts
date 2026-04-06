import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runChatCompletionLoop } from './chat-loop.js';

describe('runChatCompletionLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out stalled chat completion requests', async () => {
    const client = {
      chat: {
        completions: {
          create: vi.fn(() => new Promise(() => {})),
        },
      },
    } as any;

    const loopPromise = runChatCompletionLoop({
      client,
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      loopContext: {
        log: vi.fn(),
        env: {},
      },
      maxLoops: 1,
      completionTimeoutMs: 1234,
    });

    const assertion = expect(loopPromise).rejects.toThrow(
      'Chat completion timed out after 1234ms',
    );
    await vi.advanceTimersByTimeAsync(1234);
    await assertion;
  });
});
