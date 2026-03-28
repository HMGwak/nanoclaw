import { describe, expect, it } from 'vitest';

import { buildGroupAgentTeam, getConfiguredSpeakerNames } from './index.js';
import type { RegisteredGroup } from '../types.js';

describe('agent factory', () => {
  it('builds the workshop team from the service deployment catalog', () => {
    const group: RegisteredGroup = {
      name: '작업실',
      folder: 'discord_workshop',
      trigger: '@작업실',
      added_at: '2026-01-01T00:00:00Z',
    };

    const team = buildGroupAgentTeam(group);

    expect(team.lead?.displayName).toBe('작업실 팀장');
    expect(team.lead?.toolsetIds).toEqual(['workshop-teamleader-default']);
    expect(team.teammates).toHaveLength(1);
    expect(team.teammates[0].displayName).toBe('키미');
    expect(team.teammates[0].toolsetIds).toEqual([
      'workshop-teammate-kimi-research',
    ]);
    expect(team.teammateConfigs).toHaveLength(1);
  });

  it('falls back to the group name when no deployment exists', () => {
    const group: RegisteredGroup = {
      name: '임시 그룹',
      folder: 'custom_group',
      trigger: '@임시',
      added_at: '2026-01-01T00:00:00Z',
    };

    expect(getConfiguredSpeakerNames(group)).toEqual(['임시 그룹']);
  });
});
