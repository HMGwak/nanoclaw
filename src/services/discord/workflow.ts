import { logger } from '../../logger.js';
import { getFlowSpec, parseFlowSteps } from '../../catalog/flows/index.js';
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
  steps?: unknown[];
  chatJid?: string;
  workflowId?: string;
  stepIndex?: number;
  status?: string;
  resultSummary?: string;
}

const KARPATHY_FLOW_ID = 'karpathy-loop';
const KARPATHY_STAGE_IDS = new Set(
  (getFlowSpec(KARPATHY_FLOW_ID)?.stages || []).map((stage) => stage.id),
);
const KARPATHY_STAGE_IDS_TEXT = [...KARPATHY_STAGE_IDS].join(', ');

function validateRequiredTextList(
  value: unknown,
  fieldName: string,
): string | undefined {
  if (value === undefined || value === null) {
    return `${fieldName} is required and must be a non-empty string or a non-empty string array`;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0
      ? undefined
      : `${fieldName} is required and must be a non-empty string or a non-empty string array`;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return `${fieldName} is required and must be a non-empty string or a non-empty string array`;
  }
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      return `${fieldName} is required and must be a non-empty string or a non-empty string array`;
    }
  }
  return undefined;
}

function validateWorkflowStep(raw: unknown, index: number): string | undefined {
  if (!raw || typeof raw !== 'object') {
    return `steps[${index}] must be an object with assignee and goal`;
  }

  const step = raw as {
    assignee?: unknown;
    goal?: unknown;
    acceptance_criteria?: unknown;
    constraints?: unknown;
    stage_id?: unknown;
  };

  const assignee =
    typeof step.assignee === 'string' ? step.assignee.trim() : '';
  const goal = typeof step.goal === 'string' ? step.goal.trim() : '';
  if (!assignee || !goal) {
    return `steps[${index}] must include non-empty assignee and goal`;
  }

  const acceptanceError = validateRequiredTextList(
    step.acceptance_criteria,
    `steps[${index}].acceptance_criteria`,
  );
  if (acceptanceError) return acceptanceError;

  const constraintsError = validateRequiredTextList(
    step.constraints,
    `steps[${index}].constraints`,
  );
  if (constraintsError) return constraintsError;

  if (typeof step.stage_id !== 'string' || step.stage_id.trim().length === 0) {
    return `steps[${index}].stage_id is required and must be a non-empty string`;
  }
  const stageId = step.stage_id.trim();
  if (!KARPATHY_STAGE_IDS.has(stageId)) {
    return `steps[${index}].stage_id must be one of: ${KARPATHY_STAGE_IDS_TEXT}`;
  }

  return undefined;
}

export type DiscordWorkflowStartResult =
  | {
      ok: true;
      flowId: string;
      stepCount: number;
      chatJid: string;
    }
  | {
      ok: false;
      reason:
        | 'unauthorized'
        | 'invalid_payload'
        | 'missing_chat_jid'
        | 'invalid_steps'
        | 'missing_callback';
      error: string;
    };

export function handleDiscordWorkflowStart(
  data: DiscordWorkflowTaskPayload,
  sourceGroup: string,
  isMain: boolean,
  deps: DiscordWorkflowIpcDeps,
): DiscordWorkflowStartResult {
  if (!canStartWorkflowFromGroup(sourceGroup)) {
    logger.warn(
      { sourceGroup, isMain },
      'Unauthorized start_workflow attempt blocked',
    );
    return {
      ok: false,
      reason: 'unauthorized',
      error: `Group "${sourceGroup}" is not allowed to start workflows`,
    };
  }

  if (!data.title || !Array.isArray(data.steps) || data.steps.length === 0) {
    logger.warn(
      { data },
      'Invalid start_workflow request - missing title or steps',
    );
    return {
      ok: false,
      reason: 'invalid_payload',
      error: 'start_workflow requires non-empty title and steps',
    };
  }
  if (
    Object.prototype.hasOwnProperty.call(
      data as unknown as Record<string, unknown>,
      'flow_id',
    ) ||
    Object.prototype.hasOwnProperty.call(
      data as unknown as Record<string, unknown>,
      'flowId',
    )
  ) {
    logger.warn(
      { sourceGroup },
      'Invalid start_workflow request - flow_id is no longer accepted',
    );
    return {
      ok: false,
      reason: 'invalid_payload',
      error:
        'flow_id is no longer accepted; start_workflow always uses karpathy-loop',
    };
  }

  for (let i = 0; i < data.steps.length; i++) {
    const stepError = validateWorkflowStep(data.steps[i], i);
    if (stepError) {
      logger.warn(
        { sourceGroup, stepIndex: i },
        'Invalid start_workflow request - malformed step payload',
      );
      return {
        ok: false,
        reason: 'invalid_steps',
        error: stepError,
      };
    }
  }

  const chatJid = typeof data.chatJid === 'string' ? data.chatJid.trim() : '';
  if (!chatJid) {
    logger.warn(
      { sourceGroup },
      'Invalid start_workflow request - missing chatJid',
    );
    return {
      ok: false,
      reason: 'missing_chat_jid',
      error: 'chatJid is required for workflow routing',
    };
  }

  const steps = parseFlowSteps(KARPATHY_FLOW_ID, data.steps).map((step) => ({
    ...step,
    assignee:
      getDiscordCanonicalGroupFolderForFolder(step.assignee) || step.assignee,
  }));
  if (steps.length === 0) {
    logger.warn(
      { sourceGroup, flowId: KARPATHY_FLOW_ID, steps: data.steps },
      'Invalid start_workflow request - no valid steps after parsing',
    );
    return {
      ok: false,
      reason: 'invalid_steps',
      error:
        'No valid workflow steps found. Each step must include assignee, goal, acceptance_criteria, constraints, and stage_id.',
    };
  }
  if (steps.length !== data.steps.length) {
    logger.warn(
      {
        sourceGroup,
        flowId: KARPATHY_FLOW_ID,
        requested: data.steps.length,
        parsed: steps.length,
      },
      'Invalid start_workflow request - step normalization dropped entries',
    );
    return {
      ok: false,
      reason: 'invalid_steps',
      error:
        'Some workflow steps were invalid after normalization; request rejected.',
    };
  }
  if (!deps.onWorkflowRequested) {
    logger.error(
      { sourceGroup, flowId: KARPATHY_FLOW_ID },
      'Workflow callback missing while handling start_workflow',
    );
    return {
      ok: false,
      reason: 'missing_callback',
      error: 'Workflow engine callback is not configured',
    };
  }

  deps.onWorkflowRequested(
    data.title,
    steps,
    KARPATHY_FLOW_ID,
    sourceGroup,
    chatJid,
  );
  logger.info(
    {
      sourceGroup,
      flowId: KARPATHY_FLOW_ID,
      title: data.title,
      stepCount: steps.length,
    },
    'Workflow requested via Discord service IPC',
  );
  return {
    ok: true,
    flowId: KARPATHY_FLOW_ID,
    stepCount: steps.length,
    chatJid,
  };
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
