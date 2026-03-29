export type BrowserPolicyStage = 'cloudflare_fetch' | 'agent_browser' | 'playwright';

export interface BrowserToolPolicySpec {
  id: string;
  enforcement: 'advisory' | 'hard';
  chain: BrowserPolicyStage[];
  supplementalTools?: string[];
}

export interface ToolsetSpec {
  id: string;
  description: string;
  allowedTools: string[] | null;
  skillIds?: string[];
  mcpBindings?: string[];
  sourceModuleIds?: string[];
  browserPolicy?: BrowserToolPolicySpec;
}
