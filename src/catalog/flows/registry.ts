import { PLANNING_WORKSHOP_FLOW } from './planning-workshop.js';
import { FlowSpec } from './types.js';

const FLOWS: Record<string, FlowSpec> = {
  [PLANNING_WORKSHOP_FLOW.id]: PLANNING_WORKSHOP_FLOW,
};

export function getFlowSpec(id: string): FlowSpec | null {
  return FLOWS[id] || null;
}

export function listFlowSpecs(): FlowSpec[] {
  return Object.values(FLOWS);
}
