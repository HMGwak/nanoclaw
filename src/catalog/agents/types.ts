export interface AgentSpec {
  id: string;
  displayName: string;
  baseProfileId: string;
  personaPromptRef?: string;
  role?: string;
  defaultToolsetIds: string[];
  defaultFlowIds: string[];
}
