/**
 * Workflow Engine for NanoClaw
 * Host-driven state machine for multi-bot orchestration.
 * Manages workflow lifecycle: creation, step execution, completion, and recovery.
 */
import fs from 'fs';
import path from 'path';

import {
  createWorkflow,
  createWorkflowStep,
  getActiveWorkflowContainerCount,
  getExpiredLeases,
  getWorkflow,
  getWorkflowStep,
  getWorkflowSteps,
  getWorkflowsByStatus,
  updateWorkflow,
  updateWorkflowStep,
} from './db.js';
import {
  CONTAINER_TIMEOUT,
  GROUPS_DIR,
  MAX_WORKFLOW_CONTAINERS,
} from './config.js';
import { logger } from './logger.js';
import {
  RegisteredGroup,
  WorkflowPlanStep,
  WorkflowRun,
  WorkflowStepRun,
} from './types.js';

export interface WorkflowEngineDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  enqueueWorkflowStep: (
    groupJid: string,
    stepId: string,
    prompt: string,
    workflowContext: WorkflowStepContext,
  ) => void;
  closeStdin: (groupJid: string) => void;
}

export interface WorkflowStepContext {
  workflowId: string;
  stepId: string;
  stepIndex: number;
  role: string;
  goal: string;
  acceptanceCriteria: string[] | null;
  constraints: string[] | null;
  previousStepResult?: string;
}

export class WorkflowEngine {
  private deps: WorkflowEngineDeps;
  private pendingStepQueue: Array<{
    workflowId: string;
    stepId: string;
  }> = [];

  constructor(deps: WorkflowEngineDeps) {
    this.deps = deps;
  }

  /**
   * Request a new workflow. Creates DB records and sends confirmation to user.
   */
  async requestWorkflow(
    title: string,
    planSteps: WorkflowPlanStep[],
    sourceGroupFolder: string,
    sourceChatJid: string,
  ): Promise<WorkflowRun> {
    // Resolve assignee JIDs from registered groups
    const groups = this.deps.registeredGroups();
    for (const step of planSteps) {
      const found = Object.entries(groups).find(
        ([, g]) => g.folder === step.assignee,
      );
      if (!found) {
        throw new Error(
          `Assignee group "${step.assignee}" not found in registered groups`,
        );
      }
    }

    // Create workflow
    const wf = createWorkflow({
      title,
      sourceGroupFolder: sourceGroupFolder,
      sourceChatJid: sourceChatJid,
      planSteps,
    });

    // Create step records
    for (const step of planSteps) {
      const assigneeJid = Object.entries(groups).find(
        ([, g]) => g.folder === step.assignee,
      )![0];

      createWorkflowStep({
        workflowId: wf.id,
        stepIndex: step.step_index,
        assigneeGroupFolder: step.assignee,
        assigneeChatJid: assigneeJid,
        goal: step.goal,
        acceptanceCriteria: step.acceptance_criteria,
        constraints: step.constraints,
      });
    }

    // Transition to awaiting_confirmation
    updateWorkflow(wf.id, { status: 'awaiting_confirmation' });

    // Send confirmation message to source channel
    const stepSummary = planSteps
      .map((s, i) => `  ${i + 1}. [${s.assignee}] ${s.goal}`)
      .join('\n');

    await this.deps.sendMessage(
      sourceChatJid,
      `**워크플로우 요청: ${title}**\n\n` +
        `**단계:**\n${stepSummary}\n\n` +
        `이 워크플로우를 실행할까요? ("확인" 또는 "취소"로 응답해주세요)\n` +
        `워크플로우 ID: \`${wf.id}\``,
    );

    // Write snapshot for planning group
    this.writePendingWorkflowSnapshot(wf.id);

    logger.info(
      { workflowId: wf.id, title, steps: planSteps.length },
      'Workflow requested, awaiting confirmation',
    );

    return getWorkflow(wf.id)!;
  }

  /**
   * Confirm a workflow and start execution.
   */
  async confirmWorkflow(workflowId: string): Promise<void> {
    const wf = getWorkflow(workflowId);
    if (!wf) {
      logger.warn({ workflowId }, 'Cannot confirm: workflow not found');
      return;
    }
    if (
      wf.status !== 'pending_confirmation' &&
      wf.status !== 'awaiting_confirmation'
    ) {
      logger.warn(
        { workflowId, status: wf.status },
        'Cannot confirm: workflow not in confirmation state',
      );
      return;
    }

    updateWorkflow(workflowId, { status: 'running' });

    await this.deps.sendMessage(
      wf.source_chat_jid,
      `워크플로우 **${wf.title}** 실행을 시작합니다.`,
    );

    logger.info({ workflowId }, 'Workflow confirmed, starting execution');

    // Start first step
    await this.startNextStep(workflowId);
  }

  /**
   * Cancel a workflow.
   */
  async cancelWorkflow(
    workflowId: string,
    sourceGroup?: string,
  ): Promise<void> {
    const wf = getWorkflow(workflowId);
    if (!wf) {
      logger.warn({ workflowId }, 'Cannot cancel: workflow not found');
      return;
    }
    if (wf.status === 'completed' || wf.status === 'cancelled') {
      return;
    }

    // Check participants authorization
    if (sourceGroup) {
      const participants: string[] = wf.participants
        ? JSON.parse(wf.participants)
        : [];
      if (
        sourceGroup !== wf.source_group_folder &&
        !participants.includes(sourceGroup)
      ) {
        logger.warn({ workflowId, sourceGroup }, 'Unauthorized cancel attempt');
        return;
      }
    }

    // Close any running step containers
    const steps = getWorkflowSteps(workflowId);
    for (const step of steps) {
      if (step.status === 'claimed' || step.status === 'running') {
        updateWorkflowStep(step.id, { status: 'skipped' });
        try {
          this.deps.closeStdin(step.assignee_chat_jid);
        } catch {
          // Container may already be closed
        }
      } else if (step.status === 'pending') {
        updateWorkflowStep(step.id, { status: 'skipped' });
      }
    }

    updateWorkflow(workflowId, { status: 'cancelled' });

    await this.deps.sendMessage(
      wf.source_chat_jid,
      `워크플로우 **${wf.title}** 가 취소되었습니다.`,
    );

    logger.info({ workflowId }, 'Workflow cancelled');
    this.cleanupSnapshot(wf.source_group_folder, workflowId);
  }

  /**
   * Handle step completion reported via IPC.
   */
  async onStepCompleted(
    workflowId: string,
    stepIndex: number,
    resultSummary: string,
  ): Promise<void> {
    const wf = getWorkflow(workflowId);
    if (!wf) return;

    // Guard: ignore results for cancelled/completed workflows
    if (wf.status === 'cancelled' || wf.status === 'completed') {
      logger.info(
        { workflowId, stepIndex },
        'Ignoring step result for finished workflow',
      );
      return;
    }

    const steps = getWorkflowSteps(workflowId);
    const step = steps.find((s) => s.step_index === stepIndex);
    if (!step) return;

    updateWorkflowStep(step.id, {
      status: 'completed',
      result_summary: resultSummary,
    });

    logger.info(
      { workflowId, stepIndex, stepId: step.id },
      'Workflow step completed',
    );

    // Check if there are more steps
    const nextStepIndex = stepIndex + 1;
    const nextStep = steps.find((s) => s.step_index === nextStepIndex);

    if (nextStep) {
      updateWorkflow(workflowId, { current_step_index: nextStepIndex });
      await this.startStep(workflowId, nextStep, resultSummary);
    } else {
      // All steps completed
      updateWorkflow(workflowId, { status: 'completed' });

      await this.deps.sendMessage(
        wf.source_chat_jid,
        `워크플로우 **${wf.title}** 가 완료되었습니다.\n\n` +
          `**최종 결과:** ${resultSummary}`,
      );

      logger.info({ workflowId }, 'Workflow completed');
      this.cleanupSnapshot(wf.source_group_folder, workflowId);
    }
  }

  /**
   * Handle step failure reported via IPC.
   */
  async onStepFailed(
    workflowId: string,
    stepIndex: number,
    error: string,
  ): Promise<void> {
    const wf = getWorkflow(workflowId);
    if (!wf) return;

    if (wf.status === 'cancelled' || wf.status === 'completed') return;

    const steps = getWorkflowSteps(workflowId);
    const step = steps.find((s) => s.step_index === stepIndex);
    if (!step) return;

    if (step.retry_count < step.max_retries) {
      // Retry
      const newRetryCount = step.retry_count + 1;
      updateWorkflowStep(step.id, {
        status: 'pending',
        retry_count: newRetryCount,
        claimed_at: null,
        lease_expires_at: null,
      });

      logger.info(
        { workflowId, stepIndex, retry: newRetryCount },
        'Retrying failed step',
      );

      await this.startStep(workflowId, getWorkflowStep(step.id)!);
    } else {
      // Max retries exceeded
      updateWorkflowStep(step.id, {
        status: 'failed',
        result_summary: error,
      });
      updateWorkflow(workflowId, { status: 'failed' });

      await this.deps.sendMessage(
        wf.source_chat_jid,
        `워크플로우 **${wf.title}** Step ${stepIndex + 1} 실패 (최대 재시도 초과).\n\n**오류:** ${error}`,
      );

      logger.error(
        { workflowId, stepIndex, error },
        'Workflow step failed after max retries',
      );
      this.cleanupSnapshot(wf.source_group_folder, workflowId);
    }
  }

  /**
   * Check for expired leases and handle them.
   */
  async checkExpiredLeases(): Promise<void> {
    const expired = getExpiredLeases();
    for (const step of expired) {
      logger.warn(
        { stepId: step.id, workflowId: step.workflow_id },
        'Lease expired for workflow step',
      );
      await this.onStepFailed(
        step.workflow_id,
        step.step_index,
        'Container lease expired (timeout or crash)',
      );
    }
  }

  /**
   * Recover workflows on host restart.
   */
  async recoverOnRestart(): Promise<void> {
    // Check running workflows with expired leases
    const running = getWorkflowsByStatus('running');
    for (const wf of running) {
      const steps = getWorkflowSteps(wf.id);
      const activeStep = steps.find(
        (s) => s.status === 'claimed' || s.status === 'running',
      );

      if (activeStep) {
        if (
          activeStep.lease_expires_at &&
          new Date(activeStep.lease_expires_at) < new Date()
        ) {
          logger.info(
            { workflowId: wf.id, stepId: activeStep.id },
            'Recovering expired step after restart',
          );
          await this.onStepFailed(
            wf.id,
            activeStep.step_index,
            'Host restart with expired lease',
          );
        } else {
          logger.info(
            { workflowId: wf.id, stepId: activeStep.id },
            'Active step still within lease after restart',
          );
        }
      }
    }

    // Log awaiting workflows
    const awaiting = getWorkflowsByStatus('awaiting_confirmation');
    if (awaiting.length > 0) {
      logger.info(
        { count: awaiting.length },
        'Workflows awaiting confirmation after restart',
      );
    }
  }

  // --- Private helpers ---

  private async startNextStep(workflowId: string): Promise<void> {
    const wf = getWorkflow(workflowId)!;
    const steps = getWorkflowSteps(workflowId);
    const nextStep = steps.find((s) => s.step_index === wf.current_step_index);

    if (!nextStep) {
      updateWorkflow(workflowId, { status: 'completed' });
      logger.info({ workflowId }, 'No steps to execute, workflow completed');
      return;
    }

    await this.startStep(workflowId, nextStep);
  }

  private async startStep(
    workflowId: string,
    step: WorkflowStepRun,
    previousResult?: string,
  ): Promise<void> {
    // Check workflow container slot limit
    const activeCount = getActiveWorkflowContainerCount();
    if (activeCount >= MAX_WORKFLOW_CONTAINERS) {
      logger.info(
        { workflowId, stepId: step.id, activeCount },
        'Workflow container limit reached, queuing step',
      );
      this.pendingStepQueue.push({ workflowId, stepId: step.id });
      return;
    }

    const now = new Date();
    const leaseExpires = new Date(now.getTime() + CONTAINER_TIMEOUT);

    updateWorkflowStep(step.id, {
      status: 'claimed',
      claimed_at: now.toISOString(),
      lease_expires_at: leaseExpires.toISOString(),
    });

    // Build prompt with workflow context
    const criteria = step.acceptance_criteria
      ? JSON.parse(step.acceptance_criteria)
      : [];
    const constraints = step.constraints ? JSON.parse(step.constraints) : [];

    let prompt = `[WORKFLOW STEP ${step.step_index + 1}]\n`;
    prompt += `워크플로우 ID: ${workflowId}\n`;
    prompt += `Step ID: ${step.id}\n\n`;
    prompt += `**목표:** ${step.goal}\n`;

    if (criteria.length > 0) {
      prompt += `\n**인수 조건:**\n`;
      for (const c of criteria) {
        prompt += `- ${c}\n`;
      }
    }

    if (constraints.length > 0) {
      prompt += `\n**제약사항:**\n`;
      for (const c of constraints) {
        prompt += `- ${c}\n`;
      }
    }

    if (previousResult) {
      prompt += `\n**이전 단계 결과:**\n${previousResult}\n`;
    }

    prompt +=
      `\n작업 완료 후 반드시 \`report_result\` MCP tool을 호출하여 결과를 보고해주세요.\n` +
      `workflow_id: "${workflowId}", step_index: ${step.step_index}`;

    const context: WorkflowStepContext = {
      workflowId,
      stepId: step.id,
      stepIndex: step.step_index,
      role: 'execute',
      goal: step.goal,
      acceptanceCriteria: criteria.length > 0 ? criteria : null,
      constraints: constraints.length > 0 ? constraints : null,
      previousStepResult: previousResult,
    };

    this.deps.enqueueWorkflowStep(
      step.assignee_chat_jid,
      step.id,
      prompt,
      context,
    );

    logger.info(
      {
        workflowId,
        stepId: step.id,
        assignee: step.assignee_group_folder,
      },
      'Workflow step enqueued',
    );
  }

  /**
   * Called when a workflow step container finishes.
   * Processes pending queue.
   */
  async drainPendingSteps(): Promise<void> {
    while (this.pendingStepQueue.length > 0) {
      const activeCount = getActiveWorkflowContainerCount();
      if (activeCount >= MAX_WORKFLOW_CONTAINERS) break;

      const queued = this.pendingStepQueue.shift()!;
      const step = getWorkflowStep(queued.stepId);
      if (step && step.status === 'pending') {
        await this.startStep(queued.workflowId, step);
      }
    }
  }

  private writePendingWorkflowSnapshot(workflowId: string): void {
    const wf = getWorkflow(workflowId);
    if (!wf) return;

    const dir = path.join(
      GROUPS_DIR,
      wf.source_group_folder,
      'pending_workflows',
    );
    try {
      fs.mkdirSync(dir, { recursive: true });
      const steps = getWorkflowSteps(workflowId);
      const snapshot = {
        id: wf.id,
        title: wf.title,
        status: wf.status,
        steps: steps.map((s) => ({
          index: s.step_index,
          assignee: s.assignee_group_folder,
          goal: s.goal,
          status: s.status,
        })),
        updated_at: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(dir, `${workflowId}.json`),
        JSON.stringify(snapshot, null, 2),
      );
    } catch (err) {
      logger.error({ err, workflowId }, 'Failed to write workflow snapshot');
    }
  }

  private cleanupSnapshot(sourceGroupFolder: string, workflowId: string): void {
    const filePath = path.join(
      GROUPS_DIR,
      sourceGroupFolder,
      'pending_workflows',
      `${workflowId}.json`,
    );
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}
