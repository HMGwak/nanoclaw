export interface DiscordLocalToolsetSpec {
  id: string;
  description: string;
  importedGlobalToolsetIds: string[];
  allowedTools?: string[] | null;
  skillIds?: string[];
  mcpBindings?: string[];
  sourceModuleIds?: string[];
}

const LOCAL_TOOLSETS: Record<string, DiscordLocalToolsetSpec> = {
  discord_workshop_lead_local: {
    id: 'discord_workshop_lead_local',
    description: 'Discord workshop lead local extensions.',
    importedGlobalToolsetIds: ['global_general_cli'],
  },
  discord_workshop_research_local: {
    id: 'discord_workshop_research_local',
    description: 'Discord workshop research local extensions.',
    importedGlobalToolsetIds: ['global_browser_research'],
  },
  discord_planning_lead_local: {
    id: 'discord_planning_lead_local',
    description: 'Discord planning lead local extensions.',
    importedGlobalToolsetIds: ['global_general_cli'],
  },
  discord_secretary_lead_local: {
    id: 'discord_secretary_lead_local',
    description: 'Discord secretary lead local extensions.',
    importedGlobalToolsetIds: ['global_general_cli'],
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
