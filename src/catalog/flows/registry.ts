import { FlowSpec } from './types.js';

const FLOWS: Record<string, FlowSpec> = {
  'karpathy-loop': {
    id: 'karpathy-loop',
    title: 'Quality Loop',
    description:
      'Rubric-based iterative judgment loop. Python engine handles generate-evaluate-revise internally.',
    stages: [
      {
        id: 'execute',
        title: 'Execute Quality Loop',
        description: 'Run the full quality loop as a single black-box step',
      },
    ],
  },
};

export function getFlowSpec(id: string): FlowSpec | null {
  return FLOWS[id] || null;
}

export function listFlowSpecs(): FlowSpec[] {
  return Object.values(FLOWS);
}
