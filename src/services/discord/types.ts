export interface DiscordServiceDeploymentSpec {
  id: string;
  departmentId: 'workshop' | 'planning' | 'secretary';
  botLabel: string;
  canonicalGroupFolder: string;
  groupFolders: string[];
  leadPersonnelId: string;
  teammatePersonnelIds: string[];
  flowIds: string[];
  senderBotMap?: Record<string, string>;
  personaMode?: 'hybrid' | 'bot_only';
  responsePolicy?: 'always' | 'optional';
  requiresTrigger?: boolean;
  canStartWorkflow?: boolean;
  defaultAdditionalMounts?: import('../../types.js').AdditionalMount[];
}
