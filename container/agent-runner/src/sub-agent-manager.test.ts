import { describe, expect, it } from 'vitest';

import {
  isOpencodeFinalStepFinish,
  parseOpencodeExport,
  parseOpencodeJsonOutput,
  resolveSubAgentRuntime,
} from './sub-agent-manager.js';
import { SubAgentEntry } from './types.js';

describe('sub-agent runtime resolution', () => {
  it('inherits OpenAI OAuth proxy settings from the current container env', () => {
    const entry: SubAgentEntry = {
      name: '작업실 팀장',
      backend: 'openai',
    };

    expect(
      resolveSubAgentRuntime(entry, {
        OPENAI_API_KEY: 'not-needed',
        OPENAI_BASE_URL: 'http://host.docker.internal:10531/v1/',
        OPENAI_MODEL: 'gpt-5.4-mini',
      }),
    ).toEqual({
      transport: 'openai',
      apiKey: 'not-needed',
      baseUrl: 'http://host.docker.internal:10531/v1/',
      model: 'gpt-5.4-mini',
    });
  });

  it('inherits OpenCode credentials from the current container env', () => {
    const entry: SubAgentEntry = {
      name: '키미',
      backend: 'opencode',
    };

    expect(
      resolveSubAgentRuntime(entry, {
        OPENCODE_API_KEY: 'sk-opencode-test',
        OPENCODE_MODEL: 'opencode-go/kimi-k2.5',
      }),
    ).toEqual({
      transport: 'opencode',
      apiKey: 'sk-opencode-test',
      model: 'opencode-go/kimi-k2.5',
    });
  });

  it('keeps explicit entry credentials over env fallbacks', () => {
    const entry: SubAgentEntry = {
      name: '기획실 판정관',
      backend: 'openai-compat',
      apiKey: 'local-key',
      baseUrl: 'https://custom.example/v1/',
      model: 'glm-test',
    };

    expect(
      resolveSubAgentRuntime(entry, {
        OPENAI_COMPAT_API_KEY: 'env-key',
        OPENAI_COMPAT_BASE_URL: 'https://env.example/v1/',
        OPENAI_COMPAT_MODEL: 'env-model',
      }),
    ).toEqual({
      transport: 'openai',
      apiKey: 'local-key',
      baseUrl: 'https://custom.example/v1/',
      model: 'glm-test',
    });
  });

  it('parses opencode error events instead of treating them as empty output', () => {
    expect(
      parseOpencodeJsonOutput(
        '{"type":"error","error":{"data":{"message":"Model not found"}}}\n',
      ),
    ).toEqual({
      text: '',
      error: 'Model not found',
    });
  });

  it('recovers the final assistant text from opencode export output', () => {
    expect(
      parseOpencodeExport(
        [
          'Exporting session: ses_test',
          JSON.stringify({
            messages: [
              {
                info: { role: 'assistant', time: { completed: 123 } },
                parts: [
                  { type: 'reasoning', text: 'hidden' },
                  { type: 'text', text: '최종 답변' },
                ],
              },
            ],
          }),
        ].join('\n'),
      ),
    ).toEqual({
      text: '최종 답변',
    });
  });

  it('does not treat tool-call step finishes as the final stop condition', () => {
    expect(
      isOpencodeFinalStepFinish({
        type: 'step_finish',
        part: { reason: 'tool-calls' },
      }),
    ).toBe(false);
    expect(
      isOpencodeFinalStepFinish({
        type: 'step_finish',
        part: { reason: 'stop' },
      }),
    ).toBe(true);
  });
});
