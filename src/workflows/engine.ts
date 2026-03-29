/**
 * Workflow Engine for NanoClaw
 * Host-driven state machine for multi-bot orchestration.
 * Manages workflow lifecycle: creation, step execution, completion, and recovery.
 */
import { CONTAINER_TIMEOUT, MAX_WORKFLOW_CONTAINERS } from '../config.js';
import { getDatabase } from '../db.js';
import { logger } from '../logger.js';
import { createWorkflowRepository } from '../storage/workflows.js';
import { WorkflowRun, WorkflowStepRun } from '../types.js';
import { buildWorkflowStepPrompt } from './prompt-builder.js';
import {
  cleanupWorkflowSnapshot,
  writePendingWorkflowSnapshot,
} from './snapshots.js';
import {
  appendWorkflowStageMemoryRecord,
  formatWorkflowMemorySummary,
  readWorkflowStageMemoryRecords,
} from './memory.js';
import { WorkflowEngineDeps } from './types.js';

export class WorkflowEngine {
  private deps: WorkflowEngineDeps;
  private repository;
  private pendingStepQueue: Array<{
    workflowId: string;
    stepId: string;
  }> = [];

  constructor(deps: WorkflowEngineDeps) {
    this.deps = deps;
    this.repository =
      deps.repository ?? createWorkflowRepository(getDatabase());
  }

  /**
   * Request a new workflow. Creates DB records and sends confirmation to user.
   */
  async requestWorkflow(
    title: string,
    planSteps: import('../types.js').WorkflowPlanStep[],
    sourceGroupFolder: string,
    sourceChatJid: string,
    flowId?: string,
  ): Promise<WorkflowRun> {
    const groups = this.deps.registeredGroups();
    for (const step of planSteps) {
      const found = Object.entries(groups).find(
        ([, group]) => group.folder === step.assignee,
      );
      if (!found) {
        throw new Error(
          `Assignee group "${step.assignee}" not found in registered groups`,
        );
      }
    }

    const workflow = this.repository.createWorkflow({
      title,
      sourceGroupFolder,
      sourceChatJid,
      planSteps,
      flowId,
    });

    for (const step of planSteps) {
      const assigneeJid = Object.entries(groups).find(
        ([, group]) => group.folder === step.assignee,
      )![0];

      this.repository.createWorkflowStep({
        workflowId: workflow.id,
        stepIndex: step.step_index,
        stageId: step.stage_id,
        assigneeGroupFolder: step.assignee,
        assigneeChatJid: assigneeJid,
        goal: step.goal,
        acceptanceCriteria: step.acceptance_criteria,
        constraints: step.constraints,
      });
    }

    this.repository.updateWorkflow(workflow.id, {
      status: 'awaiting_confirmation',
    });

    const stepSummary = planSteps
      .map((step, index) => `  ${index + 1}. [${step.assignee}] ${step.goal}`)
      .join('\n');

    await this.deps.sendMessage(
      sourceChatJid,
      `**워크플로우 요청: ${title}**\n\n` +
        `**단계:**\n${stepSummary}\n\n` +
        `이 워크플로우를 실행할까요? ("확인" 또는 "취소"로 응답해주세요)\n` +
        `워크플로우 ID: \`${workflow.id}\``,
    );

    writePendingWorkflowSnapshot(this.repository, workflow.id);

    logger.info(
      { workflowId: workflow.id, flowId: flowId || null, title, steps: planSteps.length },
      'Workflow requested, awaiting confirmation',
    );

    return this.repository.getWorkflow(workflow.id)!;
  }

  async confirmWorkflow(workflowId: string): Promise<void> {
    const workflow = this.repository.getWorkflow(workflowId);
    if (!workflow) {
      logger.warn({ workflowId }, 'Cannot confirm: workflow not found');
      return;
    }
    if (
      workflow.status !== 'pending_confirmation' &&
      workflow.status !== 'awaiting_confirmation'
    ) {
      logger.warn(
        { workflowId, status: workflow.status },
        'Cannot confirm: workflow not in confirmation state',
      );
      return;
    }

    this.repository.updateWorkflow(workflowId, { status: 'running' });
    await this.deps.sendMessage(
      workflow.source_chat_jid,
      `워크플로우 **${workflow.title}** 실행을 시작합니다.`,
    );

    logger.info({ workflowId }, 'Workflow confirmed, starting execution');
    await this.startNextStep(workflowId);
  }

  async cancelWorkflow(
    workflowId: string,
    sourceGroup?: string,
  ): Promise<void> {
    const workflow = this.repository.getWorkflow(workflowId);
    if (!workflow) {
      logger.warn({ workflowId }, 'Cannot cancel: workflow not found');
      return;
    }
    if (workflow.status === 'completed' || workflow.status === 'cancelled') {
      return;
    }

    if (sourceGroup) {
      const participants: string[] = workflow.participants
        ? JSON.parse(workflow.participants)
        : [];
      if (
        sourceGroup !== workflow.source_group_folder &&
        !participants.includes(sourceGroup)
      ) {
        logger.warn({ workflowId, sourceGroup }, 'Unauthorized cancel attempt');
        return;
      }
    }

    const steps = this.repository.getWorkflowSteps(workflowId);
    for (const step of steps) {
      if (step.status === 'claimed' || step.status === 'running') {
        this.repository.updateWorkflowStep(step.id, { status: 'skipped' });
        try {
          this.deps.closeStdin(step.assignee_chat_jid);
        } catch {
          // Container may already be closed
        }
      } else if (step.status === 'pending') {
        this.repository.updateWorkflowStep(step.id, { status: 'skipped' });
      }
    }

    this.repository.updateWorkflow(workflowId, { status: 'cancelled' });
    await this.deps.sendMessage(
      workflow.source_chat_jid,
      `워크플로우 **${workflow.title}** 가 취소되었습니다.`,
    );

    logger.info({ workflowId }, 'Workflow cancelled');
    cleanupWorkflowSnapshot(
      workflow.source_group_folder,
      workflowId,
      steps.map((step) => step.assignee_group_folder),
    );
  }

  async onStepCompleted(
    workflowId: string,
    stepIndex: number,
    resultSummary: string,
  ): Promise<void> {
    const workflow = this.repository.getWorkflow(workflowId);
    if (!workflow) return;
    if (workflow.status === 'cancelled' || workflow.status === 'completed') {
      logger.info(
        { workflowId, stepIndex },
        'Ignoring step result for finished workflow',
      );
      return;
    }

    const steps = this.repository.getWorkflowSteps(workflowId);
    const step = steps.find((candidate) => candidate.step_index === stepIndex);
    if (!step) return;

    this.repository.updateWorkflowStep(step.id, {
      status: 'completed',
      result_summary: resultSummary,
    });
    appendWorkflowStageMemoryRecord(workflow.source_group_folder, workflowId, {
      timestamp: new Date().toISOString(),
      workflow_id: workflowId,
      flow_id: workflow.flow_id,
      step_id: step.id,
      step_index: step.step_index,
      stage_id: step.stage_id,
      assignee_group_folder: step.assignee_group_folder,
      status: 'completed',
      result_summary: resultSummary,
    });

    logger.info(
      { workflowId, stepIndex, stepId: step.id },
      'Workflow step completed',
    );

    const nextStepIndex = stepIndex + 1;
    const nextStep = steps.find(
      (candidate) => candidate.step_index === nextStepIndex,
    );

    if (nextStep) {
      this.repository.updateWorkflow(workflowId, {
        current_step_index: nextStepIndex,
      });
      await this.startStep(workflowId, nextStep, resultSummary);
      return;
    }

    this.repository.updateWorkflow(workflowId, { status: 'completed' });
    await this.deps.sendMessage(
      workflow.source_chat_jid,
      `워크플로우 **${workflow.title}** 가 완료되었습니다.\n\n` +
        `**최종 결과:** ${resultSummary}`,
    );

    logger.info({ workflowId }, 'Workflow completed');
    cleanupWorkflowSnapshot(
      workflow.source_group_folder,
      workflowId,
      steps.map((candidate) => candidate.assignee_group_folder),
    );
  }

  async onStepFailed(
    workflowId: string,
    stepIndex: number,
    error: string,
  ): Promise<void> {
    const workflow = this.repository.getWorkflow(workflowId);
    if (!workflow) return;
    if (workflow.status === 'cancelled' || workflow.status === 'completed') {
      return;
    }

    const steps = this.repository.getWorkflowSteps(workflowId);
    const step = steps.find((candidate) => candidate.step_index === stepIndex);
    if (!step) return;
    appendWorkflowStageMemoryRecord(workflow.source_group_folder, workflowId, {
      timestamp: new Date().toISOString(),
      workflow_id: workflowId,
      flow_id: workflow.flow_id,
      step_id: step.id,
      step_index: step.step_index,
      stage_id: step.stage_id,
      assignee_group_folder: step.assignee_group_folder,
      status: 'failed',
      result_summary: error,
    });

    if (step.retry_count < step.max_retries) {
      const newRetryCount = step.retry_count + 1;
      this.repository.updateWorkflowStep(step.id, {
        status: 'pending',
        retry_count: newRetryCount,
        claimed_at: null,
        lease_expires_at: null,
      });

      logger.info(
        { workflowId, stepIndex, retry: newRetryCount },
        'Retrying failed step',
      );

      await this.startStep(
        workflowId,
        this.repository.getWorkflowStep(step.id)!,
      );
      return;
    }

    this.repository.updateWorkflowStep(step.id, {
      status: 'failed',
      result_summary: error,
    });
    this.repository.updateWorkflow(workflowId, { status: 'failed' });

    await this.deps.sendMessage(
      workflow.source_chat_jid,
      `워크플로우 **${workflow.title}** Step ${stepIndex + 1} 실패 (최대 재시도 초과).\n\n**오류:** ${error}`,
    );

    logger.error(
      { workflowId, stepIndex, error },
      'Workflow step failed after max retries',
    );
    cleanupWorkflowSnapshot(
      workflow.source_group_folder,
      workflowId,
      steps.map((candidate) => candidate.assignee_group_folder),
    );
  }

  async checkExpiredLeases(): Promise<void> {
    const expired = this.repository.getExpiredLeases();
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

  async recoverOnRestart(): Promise<void> {
    const running = this.repository.getWorkflowsByStatus('running');
    for (const workflow of running) {
      const steps = this.repository.getWorkflowSteps(workflow.id);
      const activeStep = steps.find(
        (step) => step.status === 'claimed' || step.status === 'running',
      );

      if (!activeStep) continue;

      if (
        activeStep.lease_expires_at &&
        new Date(activeStep.lease_expires_at) < new Date()
      ) {
        logger.info(
          { workflowId: workflow.id, stepId: activeStep.id },
          'Recovering expired step after restart',
        );
        await this.onStepFailed(
          workflow.id,
          activeStep.step_index,
          'Host restart with expired lease',
        );
      } else {
        logger.info(
          { workflowId: workflow.id, stepId: activeStep.id },
          'Active step still within lease after restart',
        );
      }
    }

    const awaiting = this.repository.getWorkflowsByStatus(
      'awaiting_confirmation',
    );
    if (awaiting.length > 0) {
      logger.info(
        { count: awaiting.length },
        'Workflows awaiting confirmation after restart',
      );
    }
  }

  async drainPendingSteps(): Promise<void> {
    while (this.pendingStepQueue.length > 0) {
      const activeCount = this.repository.getActiveWorkflowContainerCount();
      if (activeCount >= MAX_WORKFLOW_CONTAINERS) break;

      const queued = this.pendingStepQueue.shift()!;
      const step = this.repository.getWorkflowStep(queued.stepId);
      if (step && step.status === 'pending') {
        await this.startStep(queued.workflowId, step);
      }
    }
  }

  private async startNextStep(workflowId: string): Promise<void> {
    const workflow = this.repository.getWorkflow(workflowId)!;
    const steps = this.repository.getWorkflowSteps(workflowId);
    const nextStep = steps.find(
      (step) => step.step_index === workflow.current_step_index,
    );

    if (!nextStep) {
      this.repository.updateWorkflow(workflowId, { status: 'completed' });
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
    const activeCount = this.repository.getActiveWorkflowContainerCount();
    if (activeCount >= MAX_WORKFLOW_CONTAINERS) {
      logger.info(
        { workflowId, stepId: step.id, activeCount },
        'Workflow container limit reached, queuing step',
      );
      this.pendingStepQueue.push({ workflowId, stepId: step.id });
      return;
    }

    const workflow = this.repository.getWorkflow(workflowId);
    if (!workflow) {
      logger.warn(
        { workflowId, stepId: step.id },
        'Cannot start step: workflow not found',
      );
      return;
    }

    const now = new Date();
    const leaseExpires = new Date(now.getTime() + CONTAINER_TIMEOUT);
    this.repository.updateWorkflowStep(step.id, {
      status: 'claimed',
      claimed_at: now.toISOString(),
      lease_expires_at: leaseExpires.toISOString(),
    });

    const memoryRecords = readWorkflowStageMemoryRecords(
      workflow.source_group_folder,
      workflowId,
    );
    const memorySummary = formatWorkflowMemorySummary({
      records: memoryRecords,
      currentStepIndex: step.step_index,
    });
    const { prompt, context } = buildWorkflowStepPrompt(
      workflowId,
      step,
      previousResult,
      {
        flowId: workflow.flow_id,
        memorySummary,
      },
    );
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
}
