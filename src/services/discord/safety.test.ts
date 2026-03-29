import { describe, expect, it } from 'vitest';

import { RegisteredGroup, NewMessage } from '../../types.js';
import {
  buildDiscordCurrentAffairsSafetyBlock,
  isDiscordCurrentAffairsTurn,
} from './safety.js';

function leadGroup(): RegisteredGroup {
  return {
    name: '작업실',
    folder: 'discord_workshop_teamlead',
    trigger: '@작업실',
    added_at: '2026-03-29T00:00:00.000Z',
  };
}

function neutralMessages(content: string): NewMessage[] {
  return [
    {
      id: 'msg-1',
      chat_jid: 'dc:100:workshop',
      sender: 'user-1',
      sender_name: 'User',
      content,
      timestamp: '2026-03-29T11:30:00.000Z',
      is_from_me: false,
      is_bot_message: false,
    },
  ];
}

describe('discord current affairs safety', () => {
  it('detects live geopolitical turns from the latest message', () => {
    expect(
      isDiscordCurrentAffairsTurn(
        neutralMessages('트럼프와 이란 충돌 가능성 어떻게 봐?'),
      ),
    ).toBe(true);
    expect(
      isDiscordCurrentAffairsTurn(
        neutralMessages('오늘 구현 이슈 테스트 결과만 정리해줘'),
      ),
    ).toBe(false);
  });

  it('builds a safety block for discord deployments on current affairs turns', () => {
    const block = buildDiscordCurrentAffairsSafetyBlock(
      leadGroup(),
      neutralMessages('Who wins, Trump or Iran?'),
    );

    expect(block).toContain('[CURRENT_AFFAIRS_SAFETY]');
    expect(block).toContain('department: workshop');
    expect(block).toContain('Do not present war/election winner-loser');
    expect(block).toContain('Keep the visible reply concise');
  });

  it('returns an empty block for non-sensitive turns or unknown groups', () => {
    expect(
      buildDiscordCurrentAffairsSafetyBlock(
        leadGroup(),
        neutralMessages('README 업데이트 방향만 알려줘'),
      ),
    ).toBe('');

    expect(
      buildDiscordCurrentAffairsSafetyBlock(
        {
          name: '일반그룹',
          folder: 'custom_group',
          trigger: '@일반',
          added_at: '2026-03-29T00:00:00.000Z',
        },
        neutralMessages('트럼프 이란 관련 뉴스 알려줘'),
      ),
    ).toBe('');
  });
});
