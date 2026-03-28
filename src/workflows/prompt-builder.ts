import { WorkflowStepRun } from '../types.js';
import { WorkflowStepContext } from './types.js';

function parseJsonArray(value: string | null): string[] {
  return value ? (JSON.parse(value) as string[]) : [];
}

export function buildWorkflowStepPrompt(
  workflowId: string,
  step: WorkflowStepRun,
  previousResult?: string,
): { prompt: string; context: WorkflowStepContext } {
  const criteria = parseJsonArray(step.acceptance_criteria);
  const constraints = parseJsonArray(step.constraints);

  let prompt = `[WORKFLOW STEP ${step.step_index + 1}]\n`;
  prompt += `워크플로우 ID: ${workflowId}\n`;
  prompt += `Step ID: ${step.id}\n\n`;
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

  prompt +=
    `\n작업 완료 후 반드시 \`report_result\` MCP tool을 호출하여 결과를 보고해주세요.\n` +
    `workflow_id: "${workflowId}", step_index: ${step.step_index}`;

  return {
    prompt,
    context: {
      workflowId,
      stepId: step.id,
      stepIndex: step.step_index,
      role: 'execute',
      goal: step.goal,
      acceptanceCriteria: criteria.length > 0 ? criteria : null,
      constraints: constraints.length > 0 ? constraints : null,
      previousStepResult: previousResult,
    },
  };
}
