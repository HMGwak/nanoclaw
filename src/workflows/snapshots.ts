import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { WorkflowRepository } from '../storage/workflows.js';

export function writePendingWorkflowSnapshot(
  repository: WorkflowRepository,
  workflowId: string,
): void {
  const workflow = repository.getWorkflow(workflowId);
  if (!workflow) return;

  const dir = path.join(
    GROUPS_DIR,
    workflow.source_group_folder,
    'pending_workflows',
  );

  try {
    fs.mkdirSync(dir, { recursive: true });
    const steps = repository.getWorkflowSteps(workflowId);
    const snapshot = {
      id: workflow.id,
      title: workflow.title,
      status: workflow.status,
      steps: steps.map((step) => ({
        index: step.step_index,
        assignee: step.assignee_group_folder,
        goal: step.goal,
        status: step.status,
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

export function cleanupWorkflowSnapshot(
  sourceGroupFolder: string,
  workflowId: string,
): void {
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
