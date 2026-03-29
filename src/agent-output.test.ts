import { describe, expect, it } from 'vitest';

import { normalizeAgentOutput, normalizeAgentOutputs } from './agent-output.js';
import { RegisteredGroup } from './types.js';

function makeGroup(): RegisteredGroup {
  return {
    name: '작업실',
    folder: 'discord_workshop',
    trigger: '@작업실',
    added_at: '2026-03-28T00:00:00.000Z',
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
      text: '키미: 제가 볼게요.',
      sender: '작업실 팀장',
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

  it('keeps non-configured speaker lines in the active speaker segment', () => {
    const outputs = normalizeAgentOutputs(
      [
        '실시간 검색이 막혔습니다.',
        '',
        '작업실 팀장: 지금은 확인된 값만 말하겠습니다.',
        '',
        '키미: 다른 출처를 다시 찾아볼게요.',
      ].join('\n'),
      makeGroup(),
      '키미',
    );

    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toEqual({
      text: '실시간 검색이 막혔습니다.',
      sender: '키미',
    });
    expect(outputs[1]?.sender).toBe('작업실 팀장');
    expect(outputs[1]?.text).toContain('지금은 확인된 값만 말하겠습니다.');
    expect(outputs[1]?.text).toContain('키미: 다른 출처를 다시 찾아볼게요.');
  });

  it('enforces a single sender when strict mode is enabled', () => {
    const outputs = normalizeAgentOutputs(
      [
        '작업실 팀장: 먼저 상태 공유합니다.',
        '',
        '키미: 구현 체크는 제가 이어서 봅니다.',
        '',
        '작업실 팀장: 정리 끝입니다.',
      ].join('\n'),
      makeGroup(),
      '작업실 팀장',
      { enforceSingleSender: true },
    );

    expect(outputs).toEqual([
      {
        text: expect.stringContaining('먼저 상태 공유합니다.'),
        sender: '작업실 팀장',
      },
      {
        text: '정리 끝입니다.',
        sender: '작업실 팀장',
      },
    ]);
    expect(outputs[0]?.text).toContain('키미: 구현 체크는 제가 이어서 봅니다.');
  });

  it('drops mismatched visible blocks in single-sender mode', () => {
    expect(
      normalizeAgentOutputs(
        [
          '<visible sender="키미">이건 키미 발화입니다.</visible>',
          '<visible sender="작업실 팀장">이건 팀장 발화입니다.</visible>',
        ].join('\n'),
        makeGroup(),
        '작업실 팀장',
        { enforceSingleSender: true },
      ),
    ).toEqual([
      {
        text: '이건 팀장 발화입니다.',
        sender: '작업실 팀장',
      },
    ]);
  });

  it('returns null when only internal output remains', () => {
    expect(
      normalizeAgentOutput('<internal>only internal</internal>', makeGroup()),
    ).toBeNull();
  });
});
