import { describe, expect, it } from 'vitest';

import { getFlowSpec, listFlowSpecs, parseFlowSteps } from './index.js';

describe('catalog flow registry', () => {
  it('loads karpathy loop flow only', () => {
    const flowIds = listFlowSpecs()
      .map((flow) => flow.id)
      .sort();
    expect(flowIds).toEqual(['karpathy-loop']);
  });

  it('exposes karpathy-loop stages in deterministic order', () => {
    const flow = getFlowSpec('karpathy-loop');
    expect(flow).not.toBeNull();
    expect(flow?.sourceModuleIds).toContain('karpathy_loop');
    expect(flow?.stages.map((stage) => stage.id)).toEqual([
      'baseline',
      'change',
      'run',
      'verify',
      'decide',
      'collect',
      'report',
    ]);
  });

  it('parses flow steps with stage defaults and normalized list fields', () => {
    const steps = parseFlowSteps('karpathy-loop', [
      {
        assignee: 'discord_workshop',
        goal: 'Capture baseline',
        acceptance_criteria: 'baseline artifact exists',
      },
      {
        assignee: 'discord_workshop',
        goal: 'Apply change',
        constraints: ['single-file edit'],
      },
    ]);

    expect(steps).toEqual([
      {
        step_index: 0,
        assignee: 'discord_workshop',
        goal: 'Capture baseline',
        acceptance_criteria: ['baseline artifact exists'],
        constraints: undefined,
        stage_id: 'baseline',
      },
      {
        step_index: 1,
        assignee: 'discord_workshop',
        goal: 'Apply change',
        acceptance_criteria: undefined,
        constraints: ['single-file edit'],
        stage_id: 'change',
      },
    ]);
  });

  it('normalizes legacy flow ids to karpathy-loop stage defaults', () => {
    const steps = parseFlowSteps('planning-workshop', [
      {
        assignee: 'discord_workshop',
        goal: 'Legacy step',
      },
    ]);

    expect(steps).toEqual([
      {
        step_index: 0,
        assignee: 'discord_workshop',
        goal: 'Legacy step',
        acceptance_criteria: undefined,
        constraints: undefined,
        stage_id: 'baseline',
      },
    ]);
  });
});
