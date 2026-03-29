import { describe, expect, it } from 'vitest';

import { PLANNING_WORKSHOP_FLOW, parsePlanningWorkshopSteps } from './index.js';

describe('planning-workshop flow', () => {
  it('defines the reusable planning-workshop flow stages', () => {
    expect(PLANNING_WORKSHOP_FLOW.id).toBe('planning-workshop');
    expect(PLANNING_WORKSHOP_FLOW.stages.map((stage) => stage.id)).toEqual([
      'plan',
      'confirm',
      'execute',
      'report',
    ]);
  });

  it('parses workflow plan steps and filters invalid entries', () => {
    const steps = parsePlanningWorkshopSteps([
      {
        assignee: 'discord_workshop',
        goal: 'Implement feature',
        acceptance_criteria: ['Tests pass'],
      },
      {
        assignee: 'discord_secretary',
      },
    ]);

    expect(steps).toEqual([
      {
        step_index: 0,
        assignee: 'discord_workshop',
        goal: 'Implement feature',
        acceptance_criteria: ['Tests pass'],
        constraints: undefined,
        stage_id: 'execute',
      },
    ]);
  });
});
