import { BrowserToolPolicySpec } from '../../../catalog/toolsets/types.js';

export interface DiscordLocalToolsetSpec {
  id: string;
  description: string;
  importedGlobalToolsetIds: string[];
  allowedTools?: string[] | null;
  skillIds?: string[];
  mcpBindings?: string[];
  sourceModuleIds?: string[];
  browserPolicy?: BrowserToolPolicySpec;
}

const LOCAL_TOOLSETS: Record<string, DiscordLocalToolsetSpec> = {
  discord_workshop_lead_local: {
    id: 'discord_workshop_lead_local',
    description: 'Discord workshop lead local extensions.',
    importedGlobalToolsetIds: ['global_general_cli', 'global_browser_research'],
  },
  discord_workshop_research_local: {
    id: 'discord_workshop_research_local',
    description: 'Discord workshop research local extensions.',
    importedGlobalToolsetIds: ['global_browser_research'],
  },
  discord_planning_lead_local: {
    id: 'discord_planning_lead_local',
    description: 'Discord planning lead local extensions.',
    importedGlobalToolsetIds: ['global_general_cli', 'global_browser_research'],
  },
  discord_secretary_lead_local: {
    id: 'discord_secretary_lead_local',
    description: 'Discord secretary lead local extensions.',
    importedGlobalToolsetIds: ['global_general_cli', 'global_browser_research', 'obsidian_vault_tools'],
  },
};

export function getDiscordLocalToolsetSpec(
  id: string,
): DiscordLocalToolsetSpec | null {
  return LOCAL_TOOLSETS[id] || null;
}

export function listDiscordLocalToolsetSpecs(): DiscordLocalToolsetSpec[] {
  return Object.values(LOCAL_TOOLSETS);
}
