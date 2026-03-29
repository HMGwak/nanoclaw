import { logger } from '../../logger.js';
import { parseFlowSteps } from '../../catalog/flows/index.js';
import { WorkflowPlanStep } from '../../types.js';
import { getDiscordCanonicalGroupFolderForFolder } from './bindings/groups.js';
import { canStartWorkflowFromGroup } from '../index.js';

export interface DiscordWorkflowIpcDeps {
  onWorkflowRequested?: (
    title: string,
    steps: WorkflowPlanStep[],
    flowId: string,
    sourceGroup: string,
    chatJid: string,
  ) => void;
  onWorkflowStepResult?: (
    workflowId: string,
    stepIndex: number,
    status: string,
    resultSummary: string,
  ) => void;
  onWorkflowCancelled?: (workflowId: string, sourceGroup: string) => void;
}

export interface DiscordWorkflowTaskPayload {
  title?: string;
  flowId?: string;
  flow_id?: string;
  steps?: unknown[];
  chatJid?: string;
  workflowId?: string;
  stepIndex?: number;
  status?: string;
  resultSummary?: string;
}

export function handleDiscordWorkflowStart(
  data: DiscordWorkflowTaskPayload,
  sourceGroup: string,
  isMain: boolean,
  deps: DiscordWorkflowIpcDeps,
): void {
  if (!canStartWorkflowFromGroup(sourceGroup, isMain)) {
    logger.warn({ sourceGroup }, 'Unauthorized start_workflow attempt blocked');
    return;
  }

  if (!data.title || !Array.isArray(data.steps) || data.steps.length === 0) {
    logger.warn(
      { data },
      'Invalid start_workflow request - missing title or steps',
    );
    return;
  }

  const flowIdRaw = data.flowId ?? data.flow_id;
  const flowId =
    typeof flowIdRaw === 'string' && flowIdRaw.trim().length > 0
      ? flowIdRaw.trim()
      : 'planning-workshop';
  const steps = parseFlowSteps(flowId, data.steps).map((step) => ({
    ...step,
    assignee:
      getDiscordCanonicalGroupFolderForFolder(step.assignee) || step.assignee,
  }));
  if (steps.length === 0 || !deps.onWorkflowRequested) {
    return;
  }

  deps.onWorkflowRequested(
    data.title,
    steps,
    flowId,
    sourceGroup,
    data.chatJid || '',
  );
  logger.info(
    { sourceGroup, flowId, title: data.title, stepCount: steps.length },
    'Workflow requested via Discord service IPC',
  );
}

export function handleDiscordWorkflowResult(
  data: DiscordWorkflowTaskPayload,
  deps: DiscordWorkflowIpcDeps,
): void {
  if (
    !data.workflowId ||
    data.stepIndex === undefined ||
    !data.status ||
    !data.resultSummary
  ) {
    logger.warn({ data }, 'Invalid report_result - missing required fields');
    return;
  }

  if (!deps.onWorkflowStepResult) {
    return;
  }

  deps.onWorkflowStepResult(
    data.workflowId,
    data.stepIndex,
    data.status,
    data.resultSummary,
  );
  logger.info(
    {
      workflowId: data.workflowId,
      stepIndex: data.stepIndex,
      status: data.status,
    },
    'Workflow step result received via Discord service IPC',
  );
}

export function handleDiscordWorkflowCancel(
  data: DiscordWorkflowTaskPayload,
  sourceGroup: string,
  deps: DiscordWorkflowIpcDeps,
): void {
  if (!data.workflowId) {
    logger.warn({ data }, 'Invalid cancel_workflow - missing workflowId');
    return;
  }

  if (!deps.onWorkflowCancelled) {
    return;
  }

  deps.onWorkflowCancelled(data.workflowId, sourceGroup);
  logger.info(
    { workflowId: data.workflowId, sourceGroup },
    'Workflow cancel requested via Discord service IPC',
  );
}
