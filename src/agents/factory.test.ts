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
    expect(team.lead?.toolsetIds).toEqual([
      'global_general_cli',
      'discord_workshop_lead_local',
    ]);
    expect(team.teammates).toHaveLength(0);
    expect(team.teammateConfigs).toHaveLength(0);
  });

  it('builds a dedicated kimi bot team from the service deployment catalog', () => {
    const group: RegisteredGroup = {
      name: '작업실-키미',
      folder: 'discord_workshop_kimi',
      trigger: '@키미',
      added_at: '2026-01-01T00:00:00Z',
    };

    const team = buildGroupAgentTeam(group);

    expect(team.lead?.displayName).toBe('키미');
    expect(team.lead?.toolsetIds).toEqual([
      'global_browser_research',
      'discord_workshop_research_local',
    ]);
    expect(team.teammates).toHaveLength(0);
    expect(team.teammateConfigs).toHaveLength(0);
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
