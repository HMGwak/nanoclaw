import { describe, expect, it } from 'vitest';

import {
  getDiscordDebateServiceSpecForGroup,
  listDiscordDebateServiceSpecs,
} from './debate.js';

const EXPECTED_MODE_ASSIGNMENTS = {
  standard: {
    judgeAgentId: 'planning_judge',
    participantRoles: {
      workshop_teamlead: 'speaker_a',
      workshop_kimi: 'speaker_b',
    },
  },
  oxford: {
    judgeAgentId: 'planning_judge',
    participantRoles: {
      workshop_teamlead: 'proposer',
      workshop_kimi: 'opposer',
    },
  },
  advocate: {
    judgeAgentId: 'planning_judge',
    participantRoles: {
      workshop_teamlead: 'defender',
      workshop_kimi: 'advocate',
    },
  },
  socratic: {
    judgeAgentId: 'planning_judge',
    participantRoles: {
      workshop_teamlead: 'respondent',
      workshop_kimi: 'questioner',
    },
  },
  delphi: {
    judgeAgentId: 'planning_judge',
    participantRoles: {
      workshop_teamlead: 'estimator_a',
      workshop_kimi: 'estimator_b',
    },
  },
  brainstorm: {
    judgeAgentId: 'planning_judge',
    participantRoles: {
      workshop_teamlead: 'ideator_a',
      workshop_kimi: 'ideator_b',
    },
  },
  tradeoff: {
    judgeAgentId: 'planning_judge',
    participantRoles: {
      workshop_teamlead: 'option_a',
      workshop_kimi: 'option_b',
    },
  },
} as const;

describe('discord debate service resources', () => {
  it('registers a single planning-owned debate spec', () => {
    const specs = listDiscordDebateServiceSpecs();

    expect(specs).toHaveLength(1);
    expect(specs[0]?.id).toBe('discord_planning_workshop_debate_v1');
    expect(specs[0]?.ownerGroupFolders).toEqual([
      'discord_planning',
      'discord_planning_bot',
    ]);
    expect(specs[0]?.outputStyle).toBe('summary_with_rounds');
  });

  it('exposes imported internal debate agents with source departments intact', () => {
    const spec = getDiscordDebateServiceSpecForGroup('discord_planning');

    expect(spec?.importedAgents).toEqual([
      {
        id: 'planning_judge',
        name: '기획실 판정관',
        sourcePersonnelId: 'discord_planning_lead',
        sourceDepartmentId: 'planning',
        role: 'Debate moderator and final synthesizer',
      },
      {
        id: 'workshop_teamlead',
        name: '작업실 팀장',
        sourcePersonnelId: 'discord_workshop_teamlead',
        sourceDepartmentId: 'workshop',
        role: 'Workshop implementation lead debate participant',
      },
      {
        id: 'workshop_kimi',
        name: '키미',
        sourcePersonnelId: 'discord_workshop_kimi',
        sourceDepartmentId: 'workshop',
        role: 'Workshop research debate participant',
      },
    ]);
  });

  it('maps all debate modes to the expected planning/workshop roles', () => {
    const spec = getDiscordDebateServiceSpecForGroup('discord_planning_bot');

    expect(spec).not.toBeNull();
    expect(spec?.modeAssignments).toEqual(EXPECTED_MODE_ASSIGNMENTS);
  });

  it('does not expose debate service wiring outside planning-owned folders', () => {
    expect(getDiscordDebateServiceSpecForGroup('discord_workshop')).toBeNull();
    expect(getDiscordDebateServiceSpecForGroup('discord_secretary')).toBeNull();
    expect(getDiscordDebateServiceSpecForGroup('')).toBeNull();
  });
});
