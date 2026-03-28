export interface DiscordServiceDeploymentSpec {
  id: string;
  groupFolders: string[];
  leadAgentId: string;
  teammateAgentIds: string[];
  flowIds: string[];
  senderBotMap?: Record<string, string>;
  personaMode?: 'hybrid' | 'bot_only';
  canStartWorkflow?: boolean;
}
