import { RegisteredGroup } from '../../../types.js';
import {
  getDiscordBotResourceByGroupFolder,
  getDiscordBotResourceByLabel,
  listDiscordBotResources,
} from '../resources/bots.js';

export interface DiscordGroupBindingSpec {
  id: string;
  departmentId: 'workshop' | 'planning' | 'secretary';
  canonicalGroupFolder: string;
  groupFolders: string[];
  botLabel: string;
  leadPersonnelId: string;
  teammatePersonnelIds: string[];
  flowIds: string[];
  senderBotMap?: Record<string, string>;
  personaMode?: 'hybrid' | 'bot_only';
  responsePolicy?: 'always' | 'optional';
  requiresTrigger?: boolean;
  canStartWorkflow?: boolean;
  defaultAdditionalMounts?: NonNullable<
    RegisteredGroup['containerConfig']
  >['additionalMounts'];
}

function buildWorkshopSenderBotMap(
  resourceId: string,
): Record<string, string> | undefined {
  if (resourceId === 'discord-workshop-teamlead') {
    return {
      '작업실 팀장': 'workshop',
      키미: 'kimi',
    };
  }
  if (resourceId === 'discord-workshop-kimi') {
    return {
      키미: 'kimi',
    };
  }
  return undefined;
}

const DISCORD_GROUP_BINDINGS: DiscordGroupBindingSpec[] =
  listDiscordBotResources().map((resource) => ({
    teammatePersonnelIds:
      resource.id === 'discord-workshop-teamlead'
        ? ['discord_workshop_kimi']
        : [],
    senderBotMap: buildWorkshopSenderBotMap(resource.id),
    id: resource.id,
    departmentId: resource.departmentId,
    canonicalGroupFolder: resource.canonicalGroupFolder,
    groupFolders: [
      resource.canonicalGroupFolder,
      ...resource.aliasGroupFolders,
    ],
    botLabel: resource.botLabel,
    leadPersonnelId: resource.leadPersonnelId,
    flowIds: [...resource.flowIds],
    personaMode: resource.personaMode,
    responsePolicy: resource.responsePolicy,
    requiresTrigger: resource.requiresTrigger,
    canStartWorkflow: resource.canStartWorkflow,
    defaultAdditionalMounts: resource.defaultAdditionalMounts,
  }));

export function getDiscordGroupBindingForGroup(
  group: RegisteredGroup | string,
): DiscordGroupBindingSpec | null {
  const folder = typeof group === 'string' ? group : group.folder;
  return (
    DISCORD_GROUP_BINDINGS.find((binding) =>
      binding.groupFolders.includes(folder),
    ) || null
  );
}

export function listDiscordGroupBindings(): DiscordGroupBindingSpec[] {
  return [...DISCORD_GROUP_BINDINGS];
}

export function getDiscordGroupBindingForBotLabel(
  label: string,
): DiscordGroupBindingSpec | null {
  const resource = getDiscordBotResourceByLabel(label);
  if (!resource) return null;
  return (
    DISCORD_GROUP_BINDINGS.find((binding) => binding.id === resource.id) || null
  );
}

export function getDiscordCanonicalGroupFolderForFolder(
  folder: string,
): string | null {
  const resource = getDiscordBotResourceByGroupFolder(folder);
  return resource?.canonicalGroupFolder || null;
}
