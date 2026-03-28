import { WorkflowPlanStep } from '../../types.js';
import { FlowSpec } from './types.js';

export const PLANNING_WORKSHOP_FLOW: FlowSpec = {
  id: 'planning-workshop',
  title: 'Planning to workshop execution',
  description:
    'A service-independent flow for planning, confirmation, delegated execution, and reporting.',
  sourceModuleIds: ['autoresearch'],
  stages: [
    {
      id: 'plan',
      title: 'Plan',
      description:
        'Prepare a stepwise plan with assignees and acceptance criteria.',
    },
    {
      id: 'confirm',
      title: 'Confirm',
      description: 'Collect user confirmation before execution starts.',
    },
    {
      id: 'execute',
      title: 'Execute',
      description: 'Execute delegated work in the assigned worker context.',
    },
    {
      id: 'report',
      title: 'Report',
      description: 'Report step and workflow results back to the source room.',
    },
  ],
};

export function parsePlanningWorkshopSteps(
  steps: unknown[],
): WorkflowPlanStep[] {
  return (
    steps as Array<{
      assignee?: string;
      goal?: string;
      acceptance_criteria?: string[];
      constraints?: string[];
    }>
  )
    .filter((step) => step.assignee && step.goal)
    .map((step, index) => ({
      step_index: index,
      assignee: step.assignee!,
      goal: step.goal!,
      acceptance_criteria: step.acceptance_criteria,
      constraints: step.constraints,
    }));
}
