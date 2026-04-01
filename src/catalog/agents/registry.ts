import { AgentSpec } from './types.js';

const AGENTS: Record<string, AgentSpec> = {
  openai_gpt54_planner: {
    id: 'openai_gpt54_planner',
    displayName: 'Planner',
    baseProfileId: 'openai_gpt54',
    role: 'Planning and coordination specialist',
    capabilityPrompt: [
      'You are operating as a planner.',
      'Your capability is problem framing, sequencing, scoping, and coordination.',
      'Prefer explicit goals, risks, constraints, and acceptance criteria over vague advice.',
      'When handing work to another agent or group, make the task executable without extra interpretation.',
    ].join('\n'),
    defaultToolsetIds: ['global_general_cli'],
    defaultFlowIds: [],
  },
  opencode_kimi_k25_researcher: {
    id: 'opencode_kimi_k25_researcher',
    displayName: 'Researcher',
    baseProfileId: 'opencode_kimi_k25',
    role: 'Research and implementation specialist',
    capabilityPrompt: [
      'You are operating as a researcher and implementation specialist.',
      'Your capability is reality-checking, exploration, and practical technical support.',
      'Prefer concrete evidence, experiments, and implementation-oriented findings.',
    ].join('\n'),
    defaultToolsetIds: ['global_browser_research'],
    defaultFlowIds: [],
  },
  openai_gpt54_generalist: {
    id: 'openai_gpt54_generalist',
    displayName: 'Generalist',
    baseProfileId: 'openai_gpt54',
    role: 'General execution specialist',
    capabilityPrompt: [
      'You are operating as a general execution specialist.',
      'Your capability is carrying work from analysis through implementation and verification.',
    ].join('\n'),
    defaultToolsetIds: ['global_general_cli'],
    defaultFlowIds: [],
  },
  openai_gpt54_reviewer: {
    id: 'openai_gpt54_reviewer',
    displayName: 'Reviewer',
    baseProfileId: 'openai_gpt54',
    role: 'Review and secretary specialist',
    capabilityPrompt: [
      'You are operating as a reviewer.',
      'Your capability is critical review, status reporting, and release-ready communication.',
      'Prefer evidence, artifact references, and explicit unresolved items.',
    ].join('\n'),
    defaultToolsetIds: ['global_general_cli'],
    defaultFlowIds: [],
  },
};

export function getAgentSpec(id: string): AgentSpec | null {
  return AGENTS[id] || null;
}

export function listAgentSpecs(): AgentSpec[] {
  return Object.values(AGENTS);
}
