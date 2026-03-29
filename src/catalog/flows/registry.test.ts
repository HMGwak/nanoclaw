import { describe, expect, it } from 'vitest';

import { getFlowSpec, listFlowSpecs, parseFlowSteps } from './index.js';

describe('catalog flow registry', () => {
  it('loads both planning and experiment loop flows', () => {
    const flowIds = listFlowSpecs()
      .map((flow) => flow.id)
      .sort();
    expect(flowIds).toEqual(['experiment-loop', 'planning-workshop']);
  });

  it('exposes experiment-loop stages in deterministic order', () => {
    const flow = getFlowSpec('experiment-loop');
    expect(flow).not.toBeNull();
    expect(flow?.sourceModuleIds).toContain('autoresearch');
    expect(flow?.stages.map((stage) => stage.id)).toEqual([
      'baseline',
      'change',
      'run',
      'verify',
      'decide',
      'report',
    ]);
  });

  it('parses flow steps with stage defaults and normalized list fields', () => {
    const steps = parseFlowSteps('experiment-loop', [
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
});
