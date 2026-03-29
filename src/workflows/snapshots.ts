import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import {
  resolveGroupFolderPath,
  resolveGroupRunPath,
} from '../group-folder.js';
import { logger } from '../logger.js';
import { WorkflowRepository } from '../storage/workflows.js';

function createWorkflowSnapshot(
  repository: WorkflowRepository,
  workflowId: string,
): {
  id: string;
  title: string;
  flow_id: string | null;
  status: string;
  steps: Array<{
    index: number;
    stage_id: string | null;
    assignee: string;
    goal: string;
    status: string;
  }>;
  updated_at: string;
} | null {
  const workflow = repository.getWorkflow(workflowId);
  if (!workflow) return null;
  const steps = repository.getWorkflowSteps(workflowId);
  return {
    id: workflow.id,
    title: workflow.title,
    flow_id: workflow.flow_id,
    status: workflow.status,
    steps: steps.map((step) => ({
      index: step.step_index,
      stage_id: step.stage_id,
      assignee: step.assignee_group_folder,
      goal: step.goal,
      status: step.status,
    })),
    updated_at: new Date().toISOString(),
  };
}

export function writePendingWorkflowSnapshot(
  repository: WorkflowRepository,
  workflowId: string,
): void {
  const workflow = repository.getWorkflow(workflowId);
  if (!workflow) return;

  const snapshot = createWorkflowSnapshot(repository, workflowId);
  if (!snapshot) return;
  const targetGroupFolders = Array.from(
    new Set([
      workflow.source_group_folder,
      ...snapshot.steps.map((step) => step.assignee),
    ]),
  );

  try {
    for (const groupFolder of targetGroupFolders) {
      const runDir = resolveGroupRunPath(groupFolder, workflowId);
      const runSnapshotPath = path.join(runDir, 'workflow.json');
      const legacyDir = path.join(
        resolveGroupFolderPath(groupFolder),
        'pending_workflows',
      );

      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(runSnapshotPath, JSON.stringify(snapshot, null, 2));

      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(
        path.join(legacyDir, `${workflowId}.json`),
        JSON.stringify(snapshot, null, 2),
      );
    }
  } catch (err) {
    logger.error({ err, workflowId }, 'Failed to write workflow snapshot');
  }
}

export function cleanupWorkflowSnapshot(
  sourceGroupFolder: string,
  workflowId: string,
  assigneeGroupFolders: string[] = [],
): void {
  const targetGroupFolders = Array.from(
    new Set([sourceGroupFolder, ...assigneeGroupFolders]),
  );
  try {
    for (const groupFolder of targetGroupFolders) {
      const filePath = path.join(
        GROUPS_DIR,
        groupFolder,
        'pending_workflows',
        `${workflowId}.json`,
      );
      const runSnapshotPath = path.join(
        GROUPS_DIR,
        groupFolder,
        'runs',
        workflowId,
        'workflow.json',
      );

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      if (fs.existsSync(runSnapshotPath)) {
        fs.unlinkSync(runSnapshotPath);
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}
