export interface AgentSpec {
  id: string;
  displayName: string;
  baseProfileId: string;
  role?: string;
  capabilityPrompt?: string;
  defaultToolsetIds: string[];
  defaultFlowIds: string[];
}
