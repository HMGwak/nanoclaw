import { WorkflowStepRun } from '../types.js';
import { WorkflowStepContext } from './types.js';

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (Array.isArray(parsed)) {
    return parsed.filter(
      (item): item is string =>
        typeof item === 'string' && item.trim().length > 0,
    );
  }
  if (typeof parsed === 'string' && parsed.trim().length > 0) {
    return [parsed.trim()];
  }
  return [];
}

interface WorkflowPromptOptions {
  flowId?: string | null;
  memorySummary?: string | null;
}

export function buildWorkflowStepPrompt(
  workflowId: string,
  step: WorkflowStepRun,
  previousResult?: string,
  options: WorkflowPromptOptions = {},
): { prompt: string; context: WorkflowStepContext } {
  const criteria = parseJsonArray(step.acceptance_criteria);
  const constraints = parseJsonArray(step.constraints);

  let prompt = `[WORKFLOW STEP ${step.step_index + 1}]\n`;
  prompt += `워크플로우 ID: ${workflowId}\n`;
  if (options.flowId) {
    prompt += `Flow ID: ${options.flowId}\n`;
  }
  if (step.stage_id) {
    prompt += `Stage ID: ${step.stage_id}\n`;
  }
  prompt += `Step ID: ${step.id}\n\n`;
  prompt += `실행 경로: /workspace/group/runs/${workflowId}\n\n`;
  prompt += `**목표:** ${step.goal}\n`;

  if (criteria.length > 0) {
    prompt += `\n**인수 조건:**\n`;
    for (const item of criteria) {
      prompt += `- ${item}\n`;
    }
  }

  if (constraints.length > 0) {
    prompt += `\n**제약사항:**\n`;
    for (const item of constraints) {
      prompt += `- ${item}\n`;
    }
  }

  if (previousResult) {
    prompt += `\n**이전 단계 결과:**\n${previousResult}\n`;
  }

  if (options.memorySummary) {
    prompt += `\n**누적 메모리 요약:**\n${options.memorySummary}\n`;
  }

  prompt +=
    `\n작업 완료 후 반드시 \`report_result\` MCP tool을 호출하여 결과를 보고해주세요.\n` +
    `workflow_id: "${workflowId}", step_index: ${step.step_index}`;

  return {
    prompt,
    context: {
      workflowId,
      flowId: options.flowId || undefined,
      stepId: step.id,
      stepIndex: step.step_index,
      stageId: step.stage_id || undefined,
      role: 'execute',
      goal: step.goal,
      acceptanceCriteria: criteria.length > 0 ? criteria : null,
      constraints: constraints.length > 0 ? constraints : null,
      previousStepResult: previousResult,
      memorySummary: options.memorySummary || undefined,
    },
  };
}
