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

function toStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
    return normalized.length > 0 ? normalized : undefined;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value.trim()];
  }
  return undefined;
}

export function parsePlanningWorkshopSteps(
  steps: unknown[],
): WorkflowPlanStep[] {
  return (
    steps as Array<{
      assignee?: string;
      goal?: string;
      acceptance_criteria?: string[] | string;
      constraints?: string[] | string;
      stage_id?: string;
    }>
  )
    .filter(
      (step) =>
        typeof step.assignee === 'string' &&
        step.assignee.trim().length > 0 &&
        typeof step.goal === 'string' &&
        step.goal.trim().length > 0,
    )
    .map((step, index) => ({
      step_index: index,
      assignee: step.assignee!.trim(),
      goal: step.goal!.trim(),
      acceptance_criteria: toStringList(step.acceptance_criteria),
      constraints: toStringList(step.constraints),
      stage_id:
        typeof step.stage_id === 'string' && step.stage_id.trim().length > 0
          ? step.stage_id.trim()
          : 'execute',
    }));
}
