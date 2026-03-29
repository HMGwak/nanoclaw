import { ContainerConfig, RegisteredGroup, SubAgentConfig } from '../types.js';

export interface ResolvedDepartmentSpec {
  id: string;
  displayName: string;
  prompt: string | null;
  handoffTemplate: string | null;
}

export interface ResolvedAgentRuntimeSpec extends SubAgentConfig {
  id: string;
  displayName: string;
  capabilityPrompt: string | null;
  personaPrompt: string | null;
  toolsetIds: string[];
  flowIds: string[];
}

export interface ResolvedServiceDeployment {
  id: string;
  service: string;
  departmentId: string;
  botLabel: string;
  canonicalGroupFolder: string;
  department: ResolvedDepartmentSpec;
  group: RegisteredGroup;
  lead: ResolvedAgentRuntimeSpec | null;
  leadCapabilityPrompt: string | null;
  leadPrompt: string | null;
  departmentPrompt: string | null;
  teammates: ResolvedAgentRuntimeSpec[];
  personnel: ResolvedAgentRuntimeSpec[];
  speakerNames: string[];
  senderBotMap: Record<string, string>;
  personaMode: 'hybrid' | 'bot_only';
  responsePolicy: 'always' | 'optional';
  requiresTrigger: boolean;
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
