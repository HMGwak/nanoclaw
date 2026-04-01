import { DiscordDepartmentId } from '../departments/index.js';

export type DiscordBotResponsePolicy = 'always' | 'optional';

export interface DiscordBotResourceSpec {
  id: string;
  departmentId: DiscordDepartmentId;
  botLabel: string;
  canonicalGroupFolder: string;
  aliasGroupFolders: string[];
  leadPersonnelId: string;
  flowIds: string[];
  personaMode: 'hybrid' | 'bot_only';
  responsePolicy: DiscordBotResponsePolicy;
  requiresTrigger: boolean;
  canStartWorkflow?: boolean;
}

const DISCORD_BOT_RESOURCES: DiscordBotResourceSpec[] = [
  {
    id: 'discord-workshop-teamlead',
    departmentId: 'workshop',
    botLabel: 'workshop',
    canonicalGroupFolder: 'discord_workshop_teamlead',
    aliasGroupFolders: ['discord_workshop'],
    leadPersonnelId: 'discord_workshop_teamlead',
    flowIds: [],
    personaMode: 'bot_only',
    responsePolicy: 'always',
    requiresTrigger: false,
  },
  {
    id: 'discord-workshop-kimi',
    departmentId: 'workshop',
    botLabel: 'kimi',
    canonicalGroupFolder: 'discord_workshop_kimi',
    aliasGroupFolders: [],
    leadPersonnelId: 'discord_workshop_kimi',
    flowIds: [],
    personaMode: 'bot_only',
    responsePolicy: 'optional',
    requiresTrigger: false,
  },
  {
    id: 'discord-planning-bot',
    departmentId: 'planning',
    botLabel: 'planning',
    canonicalGroupFolder: 'discord_planning_bot',
    aliasGroupFolders: ['discord_planning'],
    leadPersonnelId: 'discord_planning_lead',
    flowIds: [],
    personaMode: 'bot_only',
    responsePolicy: 'always',
    requiresTrigger: false,
  },
  {
    id: 'discord-secretary-bot',
    departmentId: 'secretary',
    botLabel: 'primary',
    canonicalGroupFolder: 'discord_secretary_bot',
    aliasGroupFolders: ['discord_secretary', 'main'],
    leadPersonnelId: 'discord_secretary_lead',
    flowIds: [],
    personaMode: 'bot_only',
    responsePolicy: 'always',
    requiresTrigger: false,
  },
];

export function listDiscordBotResources(): DiscordBotResourceSpec[] {
  return [...DISCORD_BOT_RESOURCES];
}

export function getDiscordBotResourceByLabel(
  label: string,
): DiscordBotResourceSpec | null {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return null;
  return (
    DISCORD_BOT_RESOURCES.find(
      (resource) => resource.botLabel.toLowerCase() === normalized,
    ) || null
  );
}

export function getDiscordBotResourceByGroupFolder(
  folder: string,
): DiscordBotResourceSpec | null {
  const normalized = folder.trim();
  if (!normalized) return null;
  return (
    DISCORD_BOT_RESOURCES.find(
      (resource) =>
        resource.canonicalGroupFolder === normalized ||
        resource.aliasGroupFolders.includes(normalized),
    ) || null
  );
}
