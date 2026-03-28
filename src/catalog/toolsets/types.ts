export interface ToolsetSpec {
  id: string;
  description: string;
  allowedTools: string[] | null;
  skillIds?: string[];
  mcpBindings?: string[];
  sourceModuleIds?: string[];
}
