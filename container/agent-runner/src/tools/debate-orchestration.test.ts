import { describe, expect, it } from 'vitest';

import {
  DEBATE_MODE_IDS,
  runDebateWithAgents,
  validateDebateRequest,
  type DebateAgentRunner,
  type DebateModeId,
  type DebateRequest,
} from './debate-orchestration.js';

const EXPECTED_DEFAULT_ROUNDS: Record<DebateModeId, number> = {
  standard: 3,
  oxford: 3,
  advocate: 3,
  socratic: 4,
  delphi: 3,
  brainstorm: 3,
  tradeoff: 3,
};

const EXPECTED_PARTICIPANT_ROLES: Record<
  DebateModeId,
  Record<string, string>
> = {
  standard: {
    '작업실 팀장': 'speaker_a',
    키미: 'speaker_b',
    '기획실 판정관': 'final judge',
  },
  oxford: {
    '작업실 팀장': 'proposer',
    키미: 'opposer',
    '기획실 판정관': 'adjudicator',
  },
  advocate: {
    '작업실 팀장': 'defender',
    키미: 'advocate',
    '기획실 판정관': 'final judge',
  },
  socratic: {
    '작업실 팀장': 'respondent',
    키미: 'questioner',
    '기획실 판정관': 'synthesizer',
  },
  delphi: {
    '작업실 팀장': 'estimator_a',
    키미: 'estimator_b',
    '기획실 판정관': 'synthesizer',
  },
  brainstorm: {
    '작업실 팀장': 'ideator_a',
    키미: 'ideator_b',
    '기획실 판정관': 'curator',
  },
  tradeoff: {
    '작업실 팀장': 'option_a',
    키미: 'option_b',
    '기획실 판정관': 'evaluator',
  },
};

function createRunner(
  missingAgents: string[] = [],
): DebateAgentRunner & {
  calls: Array<{ name: string; prompt: string; systemPrompt?: string }>;
} {
  const available = new Set(['작업실 팀장', '키미', '기획실 판정관']);
  for (const missing of missingAgents) available.delete(missing);

  const calls: Array<{ name: string; prompt: string; systemPrompt?: string }> =
    [];

  return {
    calls,
    hasAgent(name: string): boolean {
      return available.has(name);
    },
    async askAgent(
      name: string,
      prompt: string,
      systemPrompt?: string,
    ): Promise<string> {
      calls.push({ name, prompt, systemPrompt });
      if (name === '기획실 판정관' && prompt.includes('Respond in Korean with 3-5 bullets only.')) {
        return `라운드 요약(${calls.length})`;
      }
      if (name === '기획실 판정관') {
        return '결론:\n- 유지\n\n근거:\n- 충분한 검토 완료\n\n소수 의견:\n- 추가 검증 여지\n\n다음 확인 포인트:\n- 통합 테스트';
      }
      return `${name} 응답`;
    },
  };
}

describe('debate orchestration', () => {
  it('fills default rounds per mode and normalizes evidence/background input', () => {
    for (const mode of DEBATE_MODE_IDS) {
      const parsed = validateDebateRequest({
        topic: '어떤 구조가 더 맞는가',
        mode,
        background_knowledge_refs: [' ADR-1 ', '', ' spec '],
        evidence_packs: [
          {
            type: 'web',
            ref: ' https://example.com ',
            title: ' docs ',
            summary: ' summary ',
          },
        ],
      });

      expect(parsed).toEqual({
        ok: true,
        request: {
          topic: '어떤 구조가 더 맞는가',
          mode,
          rounds: EXPECTED_DEFAULT_ROUNDS[mode],
          backgroundKnowledgeRefs: ['ADR-1', 'spec'],
          evidencePacks: [
            {
              type: 'web',
              ref: 'https://example.com',
              title: 'docs',
              summary: 'summary',
            },
          ],
        },
      });
    }
  });

  it('rejects malformed debate requests early', () => {
    expect(validateDebateRequest(null)).toEqual({
      ok: false,
      error: 'Debate request must be an object',
    });
    expect(validateDebateRequest({ topic: 'x' })).toEqual({
      ok: false,
      error: `mode must be one of: ${DEBATE_MODE_IDS.join(', ')}`,
    });
    expect(
      validateDebateRequest({
        topic: 'x',
        mode: 'standard',
      }),
    ).toEqual({
      ok: false,
      error:
        'evidence_packs is required; collect objective evidence first and pass it into run_debate',
    });
    expect(
      validateDebateRequest({
        topic: 'x',
        mode: 'standard',
        evidence_packs: [],
      }),
    ).toEqual({
      ok: false,
      error: 'evidence_packs must include at least one objective evidence item',
    });
    expect(
      validateDebateRequest({
        topic: 'x',
        mode: 'standard',
        rounds: 0,
        evidence_packs: [{ type: 'web', ref: 'https://example.com' }],
      }),
    ).toEqual({
      ok: false,
      error: 'rounds must be an integer between 1 and 12',
    });
    expect(
      validateDebateRequest({
        topic: 'x',
        mode: 'standard',
        evidence_packs: [{ type: 'invalid', ref: 'x' }],
      }),
    ).toEqual({
      ok: false,
      error:
        'evidence_packs[].type must be one of: web, file, memory, karpathy_loop_brief',
    });
  });

  it('returns a summary-with-rounds result for every debate mode', async () => {
    for (const mode of DEBATE_MODE_IDS) {
      const runner = createRunner();
      const request: DebateRequest = {
        topic: `mode:${mode}`,
        mode,
        rounds: 1,
        backgroundKnowledgeRefs: ['ADR-42'],
        evidencePacks: [
          {
            type: 'web',
            ref: 'https://example.com/brief',
            title: 'brief',
            summary: 'shared evidence',
          },
        ],
      };

      const result = await runDebateWithAgents(request, runner, () => {});

      expect(result).toEqual({
        ok: true,
        topic: `mode:${mode}`,
        mode,
        rounds: 1,
        output_style: 'summary_with_rounds',
        participant_roles: EXPECTED_PARTICIPANT_ROLES[mode],
        round_summaries: [
          {
            round: 1,
            workshopTeamlead: '작업실 팀장 응답',
            kimi: '키미 응답',
            summary: '라운드 요약(3)',
          },
        ],
        synthesis:
          '결론:\n- 유지\n\n근거:\n- 충분한 검토 완료\n\n소수 의견:\n- 추가 검증 여지\n\n다음 확인 포인트:\n- 통합 테스트',
      });

      expect(runner.calls).toHaveLength(4);
      expect(runner.calls[0]?.systemPrompt).toContain(
        EXPECTED_PARTICIPANT_ROLES[mode]['작업실 팀장'],
      );
      expect(runner.calls[0]?.prompt).toContain(
        'Use the provided evidence packs as the primary basis for this debate.',
      );
      expect(runner.calls[1]?.systemPrompt).toContain(
        EXPECTED_PARTICIPANT_ROLES[mode].키미,
      );
      expect(runner.calls[1]?.prompt).toContain(
        'You may use your allowed tools to verify or deepen the evidence before answering if needed.',
      );
      if (mode === 'tradeoff') {
        expect(runner.calls[1]?.prompt).toContain(
          'Defend the strongest opposing option or side to option_a.',
        );
      }
      expect(runner.calls[2]?.systemPrompt).toContain(
        EXPECTED_PARTICIPANT_ROLES[mode]['기획실 판정관'],
      );
      expect(runner.calls[3]?.prompt).toContain('결론:');
    }
  });

  it('emits round progress updates after each completed round', async () => {
    const runner = createRunner();
    const progress: string[] = [];

    const result = await runDebateWithAgents(
      {
        topic: '진행상황을 라운드마다 보여줄 수 있는가',
        mode: 'tradeoff',
        rounds: 2,
        backgroundKnowledgeRefs: [],
        evidencePacks: [{ type: 'web', ref: 'https://example.com' }],
      },
      runner,
      () => {},
      (message) => {
        progress.push(message);
      },
    );

    expect(result).toMatchObject({
      ok: true,
      rounds: 2,
    });
    expect(progress).toHaveLength(2);
    expect(progress[0]).toContain('토론 진행 상황: 라운드 1/2 종료');
    expect(progress[0]).toContain('역할 구도: 작업실 팀장(option_a) vs 키미(option_b)');
    expect(progress[0]).toContain(
      '이번 라운드의 세부 발언은 내부 토론으로 유지하고, 판정 요약만 공유합니다.',
    );
    expect(progress[0]).toContain('다음 라운드를 이어서 진행합니다.');
    expect(progress[1]).toContain('토론 진행 상황: 라운드 2/2 종료');
    expect(progress[1]).toContain('최종 종합 결론을 정리 중입니다.');
  });

  it('fails clearly when an imported debate participant is unavailable', async () => {
    const runner = createRunner(['키미']);

    const result = await runDebateWithAgents(
      {
        topic: '누가 빠졌는지 확인',
        mode: 'tradeoff',
        rounds: 1,
        backgroundKnowledgeRefs: [],
        evidencePacks: [{ type: 'web', ref: 'https://example.com' }],
      },
      runner,
      () => {},
    );

    expect(result).toEqual({
      ok: false,
      error: 'run_debate requires imported debate agents: 키미',
    });
    expect(runner.calls).toHaveLength(0);
  });

  it('retries a participant when the first response is <internal>skip</internal>', async () => {
    const runner = createRunner();
    let kimiAttempts = 0;
    runner.askAgent = async (
      name: string,
      prompt: string,
      systemPrompt?: string,
    ): Promise<string> => {
      runner.calls.push({ name, prompt, systemPrompt });
      if (name === '키미') {
        kimiAttempts += 1;
        return kimiAttempts === 1 ? '<internal>skip</internal>' : '키미 재시도 응답';
      }
      if (
        name === '기획실 판정관' &&
        prompt.includes('Respond in Korean with 3-5 bullets only.')
      ) {
        return '라운드 요약';
      }
      if (name === '기획실 판정관') {
        return '결론:\n- 채택\n\n근거:\n- 충분\n\n소수 의견:\n- 보완 가능\n\n다음 확인 포인트:\n- e2e';
      }
      return '작업실 팀장 응답';
    };

    const result = await runDebateWithAgents(
      {
        topic: 'skip 재시도 확인',
        mode: 'tradeoff',
        rounds: 1,
        backgroundKnowledgeRefs: [],
        evidencePacks: [{ type: 'web', ref: 'https://example.com' }],
      },
      runner,
      () => {},
    );

    expect(result).toMatchObject({
      ok: true,
      round_summaries: [
        {
          kimi: '키미 재시도 응답',
        },
      ],
    });
    expect(kimiAttempts).toBe(2);
    expect(
      runner.calls.some((call) =>
        call.prompt.includes(
          'Return a concrete position, rebuttal, and next pressure point instead of <internal>skip</internal>.',
        ),
      ),
    ).toBe(true);
  });
});
