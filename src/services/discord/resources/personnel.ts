export interface DiscordPersonnelSpec {
  id: string;
  displayName: string;
  catalogAgentId: string;
  promptId: string;
  localToolsetIds: string[];
  flowIds: string[];
  role?: string;
}

const DISCORD_PERSONNEL: Record<string, DiscordPersonnelSpec> = {
  discord_workshop_teamlead: {
    id: 'discord_workshop_teamlead',
    displayName: '작업실 팀장',
    catalogAgentId: 'openai_gpt54_planner',
    promptId: 'discord_workshop_teamlead',
    localToolsetIds: ['discord_workshop_lead_local'],
    flowIds: ['planning-workshop'],
    role: 'Workshop team lead',
  },
  discord_workshop_kimi: {
    id: 'discord_workshop_kimi',
    displayName: '키미',
    catalogAgentId: 'opencode_kimi_k25_researcher',
    promptId: 'discord_workshop_kimi',
    localToolsetIds: ['discord_workshop_research_local'],
    flowIds: ['planning-workshop'],
    role: 'Workshop implementation and research teammate',
  },
  discord_planning_lead: {
    id: 'discord_planning_lead',
    displayName: '기획실',
    catalogAgentId: 'openai_gpt54_planner',
    promptId: 'discord_planning_lead',
    localToolsetIds: ['discord_planning_lead_local'],
    flowIds: ['planning-workshop'],
    role: 'Planning lead',
  },
  discord_secretary_lead: {
    id: 'discord_secretary_lead',
    displayName: '비서실',
    catalogAgentId: 'openai_gpt54_reviewer',
    promptId: 'discord_secretary_lead',
    localToolsetIds: ['discord_secretary_lead_local'],
    flowIds: [],
    role: 'Secretary lead',
  },
};

export function getDiscordPersonnelSpec(
  id: string,
): DiscordPersonnelSpec | null {
  return DISCORD_PERSONNEL[id] || null;
}

export function listDiscordPersonnelSpecs(): DiscordPersonnelSpec[] {
  return Object.values(DISCORD_PERSONNEL);
}
