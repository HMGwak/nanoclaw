import { ContainerConfig, RegisteredGroup, SubAgentConfig } from '../types.js';

export interface ResolvedAgentRuntimeSpec extends SubAgentConfig {
  id: string;
  displayName: string;
  toolsetIds: string[];
  flowIds: string[];
}

export interface ResolvedServiceDeployment {
  id: string;
  service: string;
  group: RegisteredGroup;
  lead: ResolvedAgentRuntimeSpec | null;
  teammates: ResolvedAgentRuntimeSpec[];
  speakerNames: string[];
  senderBotMap: Record<string, string>;
  personaMode: 'hybrid' | 'bot_only';
  flowIds: string[];
  canStartWorkflow: boolean;
  containerRuntime: Pick<
    ContainerConfig,
    | 'additionalMounts'
    | 'timeout'
    | 'backend'
    | 'allowedTools'
    | 'model'
    | 'apiKey'
    | 'baseUrl'
  >;
}
