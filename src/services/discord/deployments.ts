import { RegisteredGroup } from '../../types.js';
import { DiscordServiceDeploymentSpec } from './types.js';

const DISCORD_DEPLOYMENTS: DiscordServiceDeploymentSpec[] = [
  {
    id: 'discord-workshop',
    groupFolders: ['discord_workshop'],
    leadAgentId: 'workshop-teamleader-gpt',
    teammateAgentIds: ['workshop-teammate-kimi'],
    flowIds: ['planning-workshop'],
    senderBotMap: {
      '작업실 팀장': 'workshop',
      키미: 'kimi',
    },
    personaMode: 'bot_only',
  },
  {
    id: 'discord-planning',
    groupFolders: ['discord_planning'],
    leadAgentId: 'planning-lead',
    teammateAgentIds: [],
    flowIds: ['planning-workshop'],
    canStartWorkflow: true,
  },
  {
    id: 'discord-secretary',
    groupFolders: ['discord_secretary', 'main'],
    leadAgentId: 'secretary-lead',
    teammateAgentIds: [],
    flowIds: [],
  },
];

export function getDiscordDeploymentForGroup(
  group: RegisteredGroup | string,
): DiscordServiceDeploymentSpec | null {
  const folder = typeof group === 'string' ? group : group.folder;
  return (
    DISCORD_DEPLOYMENTS.find((deployment) =>
      deployment.groupFolders.includes(folder),
    ) || null
  );
}

export function listDiscordDeployments(): DiscordServiceDeploymentSpec[] {
  return [...DISCORD_DEPLOYMENTS];
}
