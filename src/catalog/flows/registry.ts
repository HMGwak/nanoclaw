import { KARPATHY_LOOP_FLOW } from './karpathy-loop.js';
import { FlowSpec } from './types.js';

const FLOWS: Record<string, FlowSpec> = {
  [KARPATHY_LOOP_FLOW.id]: KARPATHY_LOOP_FLOW,
};

export function getFlowSpec(id: string): FlowSpec | null {
  return FLOWS[id] || null;
}

export function listFlowSpecs(): FlowSpec[] {
  return Object.values(FLOWS);
}
