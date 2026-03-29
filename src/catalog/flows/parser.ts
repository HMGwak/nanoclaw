import { WorkflowPlanStep } from '../../types.js';
import { getFlowSpec } from './registry.js';
import { parsePlanningWorkshopSteps } from './planning-workshop.js';

function toStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value.filter(
      (item): item is string =>
        typeof item === 'string' && item.trim().length > 0,
    );
    return normalized.length > 0 ? normalized : undefined;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value.trim()];
  }
  return undefined;
}

export function parseFlowSteps(
  flowId: string | undefined,
  steps: unknown[],
): WorkflowPlanStep[] {
  if (flowId === 'planning-workshop') {
    return parsePlanningWorkshopSteps(steps);
  }

  const stageDefaults = flowId
    ? (getFlowSpec(flowId)?.stages || []).map((stage) => stage.id)
    : [];

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
          : stageDefaults[index],
    }));
}
