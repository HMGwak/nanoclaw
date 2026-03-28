import { AgentSpec } from './types.js';

const AGENTS: Record<string, AgentSpec> = {
  'workshop-teamleader-gpt': {
    id: 'workshop-teamleader-gpt',
    displayName: '작업실 팀장',
    baseProfileId: 'workshop-teamleader-gpt',
    role: 'Workshop team lead',
    defaultToolsetIds: ['workshop-teamleader-default'],
    defaultFlowIds: ['planning-workshop'],
  },
  'workshop-teammate-kimi': {
    id: 'workshop-teammate-kimi',
    displayName: '키미',
    baseProfileId: 'workshop-teammate-kimi',
    role: 'Workshop implementation and research teammate',
    defaultToolsetIds: ['workshop-teammate-kimi-research'],
    defaultFlowIds: ['planning-workshop'],
  },
  'planning-lead': {
    id: 'planning-lead',
    displayName: '기획실',
    baseProfileId: 'planning-lead-gpt',
    role: 'Planning lead',
    defaultToolsetIds: ['planning-default'],
    defaultFlowIds: ['planning-workshop'],
  },
  'secretary-lead': {
    id: 'secretary-lead',
    displayName: '비서실',
    baseProfileId: 'secretary-lead-gpt',
    role: 'Secretary lead',
    defaultToolsetIds: ['secretary-default'],
    defaultFlowIds: [],
  },
};

export function getAgentSpec(id: string): AgentSpec | null {
  return AGENTS[id] || null;
}

export function listAgentSpecs(): AgentSpec[] {
  return Object.values(AGENTS);
}
