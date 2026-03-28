import { describe, expect, it } from 'vitest';

import { normalizeAgentOutput, normalizeAgentOutputs } from './agent-output.js';
import { RegisteredGroup } from './types.js';

function makeGroup(): RegisteredGroup {
  return {
    name: '작업실',
    folder: 'discord_workshop',
    trigger: '@작업실',
    added_at: '2026-03-28T00:00:00.000Z',
    containerConfig: {
      leadSender: '작업실 팀장',
      subAgents: [
        {
          name: '키미',
          backend: 'opencode',
        },
      ],
    },
  };
}

describe('normalizeAgentOutput', () => {
  it('defaults to the lead sender when no explicit speaker metadata is present', () => {
    expect(normalizeAgentOutput('안녕하세요!', makeGroup())).toEqual({
      text: '안녕하세요!',
      sender: '작업실 팀장',
    });
  });

  it('routes to a named speaker when the text starts with a speaker prefix', () => {
    expect(normalizeAgentOutput('키미: 제가 볼게요.', makeGroup())).toEqual({
      text: '제가 볼게요.',
      sender: '키미',
    });
  });

  it('strips internal blocks before sending visible output', () => {
    expect(
      normalizeAgentOutput(
        '<internal>생각 중</internal>\n작업실 팀장: 정리해보겠습니다.',
        makeGroup(),
      ),
    ).toEqual({
      text: '정리해보겠습니다.',
      sender: '작업실 팀장',
    });
  });

  it('supports structured visible output with sender metadata', () => {
    expect(
      normalizeAgentOutput(
        '<visible sender="키미">바로 확인해볼게요.</visible>',
        makeGroup(),
      ),
    ).toEqual({
      text: '바로 확인해볼게요.',
      sender: '키미',
    });
  });

  it('preserves multiple visible blocks as separate visible messages', () => {
    expect(
      normalizeAgentOutputs(
        [
          '<visible sender="키미">첫 의견입니다.</visible>',
          '<visible sender="작업실 팀장">정리 의견입니다.</visible>',
        ].join('\n'),
        makeGroup(),
      ),
    ).toEqual([
      {
        text: '첫 의견입니다.',
        sender: '키미',
      },
      {
        text: '정리 의견입니다.',
        sender: '작업실 팀장',
      },
    ]);
  });

  it('splits plain multi-speaker transcripts into separate outputs', () => {
    expect(
      normalizeAgentOutputs(
        [
          '실시간 검색이 막혔습니다.',
          '',
          '작업실 팀장: 지금은 확인된 값만 말하겠습니다.',
          '',
          '키미: 다른 출처를 다시 찾아볼게요.',
        ].join('\n'),
        makeGroup(),
        '키미',
      ),
    ).toEqual([
      {
        text: '실시간 검색이 막혔습니다.',
        sender: '키미',
      },
      {
        text: '지금은 확인된 값만 말하겠습니다.',
        sender: '작업실 팀장',
      },
      {
        text: '다른 출처를 다시 찾아볼게요.',
        sender: '키미',
      },
    ]);
  });

  it('returns null when only internal output remains', () => {
    expect(normalizeAgentOutput('<internal>only internal</internal>', makeGroup())).toBeNull();
  });
});
