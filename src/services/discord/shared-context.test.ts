import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from '../../db.js';
import { RegisteredGroup } from '../../types.js';
import {
  buildDiscordSharedContextBlock,
  recordDiscordSharedVisibleReply,
} from './shared-context.js';

function leadGroup(): RegisteredGroup {
  return {
    name: '작업실',
    folder: 'discord_workshop_teamlead',
    trigger: '@작업실',
    added_at: '2026-03-29T00:00:00.000Z',
  };
}

function kimiGroup(): RegisteredGroup {
  return {
    name: '작업실-키미',
    folder: 'discord_workshop_kimi',
    trigger: '@키미',
    added_at: '2026-03-29T00:00:00.000Z',
  };
}

beforeEach(() => {
  _initTestDatabase();
});

describe('discord shared context', () => {
  it('shares visible replies within the same department and channel', () => {
    recordDiscordSharedVisibleReply(
      leadGroup(),
      'dc:100:workshop',
      '작업실 팀장',
      '팀장 답변',
      '2026-03-29T10:00:00.000Z',
    );
    recordDiscordSharedVisibleReply(
      kimiGroup(),
      'dc:100:kimi',
      '키미',
      '키미 답변',
      '2026-03-29T10:01:00.000Z',
    );
    recordDiscordSharedVisibleReply(
      leadGroup(),
      'dc:200:workshop',
      '작업실 팀장',
      '다른 채널',
      '2026-03-29T10:02:00.000Z',
    );

    const blockForLead = buildDiscordSharedContextBlock(
      leadGroup(),
      'dc:100:workshop',
      {
        beforeTimestamp: '2026-03-29T10:05:00.000Z',
      },
    );
    const blockForKimi = buildDiscordSharedContextBlock(
      kimiGroup(),
      'dc:100:kimi',
      {
        beforeTimestamp: '2026-03-29T10:05:00.000Z',
      },
    );

    expect(blockForLead).toContain('키미: 키미 답변');
    expect(blockForLead).not.toContain('작업실 팀장: 팀장 답변');
    expect(blockForLead).not.toContain('다른 채널');
    expect(blockForKimi).toContain('작업실 팀장: 팀장 답변');
    expect(blockForKimi).not.toContain('키미: 키미 답변');
  });

  it('respects beforeTimestamp and returns empty block when no entries match', () => {
    recordDiscordSharedVisibleReply(
      kimiGroup(),
      'dc:100:kimi',
      '키미',
      '최신 응답',
      '2026-03-29T10:10:00.000Z',
    );

    const block = buildDiscordSharedContextBlock(
      leadGroup(),
      'dc:100:workshop',
      {
        beforeTimestamp: '2026-03-29T10:05:00.000Z',
      },
    );

    expect(block).toBe('');
  });
});
