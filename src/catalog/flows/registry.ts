import { FlowSpec } from './types.js';

const FLOWS: Record<string, FlowSpec> = {};

export function getFlowSpec(id: string): FlowSpec | null {
  return FLOWS[id] || null;
}

export function listFlowSpecs(): FlowSpec[] {
  return Object.values(FLOWS);
}
