import { DebateModeId } from '../../../catalog/methods/debate/types.js';
import { DiscordDepartmentId } from '../departments/index.js';

export interface DiscordDebateImportedAgentSpec {
  id: string;
  name: string;
  sourcePersonnelId: string;
  sourceDepartmentId: DiscordDepartmentId;
  role: string;
}

export interface DiscordDebateModeAssignmentSpec {
  judgeAgentId: string;
  participantRoles: Record<string, string>;
}

export interface DiscordDebateServiceSpec {
  id: string;
  ownerGroupFolders: string[];
  outputStyle: 'summary_with_rounds';
  importedAgents: DiscordDebateImportedAgentSpec[];
  modeAssignments: Record<DebateModeId, DiscordDebateModeAssignmentSpec>;
}

const PLANNING_WORKSHOP_DEBATE_SPEC: DiscordDebateServiceSpec = {
  id: 'discord_planning_workshop_debate_v1',
  ownerGroupFolders: ['discord_planning', 'discord_planning_bot'],
  outputStyle: 'summary_with_rounds',
  importedAgents: [
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
  ],
  modeAssignments: {
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
  },
};

const DISCORD_DEBATE_SERVICE_SPECS: DiscordDebateServiceSpec[] = [
  PLANNING_WORKSHOP_DEBATE_SPEC,
];

export function listDiscordDebateServiceSpecs(): DiscordDebateServiceSpec[] {
  return [...DISCORD_DEBATE_SERVICE_SPECS];
}

export function getDiscordDebateServiceSpecForGroup(
  groupFolder: string,
): DiscordDebateServiceSpec | null {
  const normalized = groupFolder.trim();
  if (!normalized) return null;
  return (
    DISCORD_DEBATE_SERVICE_SPECS.find((spec) =>
      spec.ownerGroupFolders.includes(normalized),
    ) || null
  );
}
