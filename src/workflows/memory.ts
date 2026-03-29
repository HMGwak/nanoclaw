import fs from 'fs';
import path from 'path';

import { resolveGroupRunPath } from '../group-folder.js';
import { logger } from '../logger.js';

const MEMORY_DIR = 'memory';
const STAGE_EVENTS_FILE = 'stage-events.jsonl';
const DEFAULT_MEMORY_RECORD_LIMIT = 5;

export interface WorkflowStageMemoryRecord {
  timestamp: string;
  workflow_id: string;
  flow_id: string | null;
  step_id: string;
  step_index: number;
  stage_id: string | null;
  assignee_group_folder: string;
  status: 'completed' | 'failed';
  result_summary: string;
}

function resolveStageEventsPath(
  groupFolder: string,
  workflowId: string,
): string {
  const runDir = resolveGroupRunPath(groupFolder, workflowId);
  const memoryDir = path.join(runDir, MEMORY_DIR);
  fs.mkdirSync(memoryDir, { recursive: true });
  return path.join(memoryDir, STAGE_EVENTS_FILE);
}

export function appendWorkflowStageMemoryRecord(
  groupFolder: string,
  workflowId: string,
  record: WorkflowStageMemoryRecord,
): void {
  try {
    const filePath = resolveStageEventsPath(groupFolder, workflowId);
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    logger.error(
      { err, groupFolder, workflowId },
      'Failed to append workflow stage memory record',
    );
  }
}

export function readWorkflowStageMemoryRecords(
  groupFolder: string,
  workflowId: string,
): WorkflowStageMemoryRecord[] {
  try {
    const filePath = resolveStageEventsPath(groupFolder, workflowId);
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as WorkflowStageMemoryRecord);
  } catch (err) {
    logger.error(
      { err, groupFolder, workflowId },
      'Failed to read workflow stage memory records',
    );
    return [];
  }
}

export function formatWorkflowMemorySummary(args: {
  records: WorkflowStageMemoryRecord[];
  currentStepIndex: number;
  maxRecords?: number;
}): string | null {
  const limit = args.maxRecords || DEFAULT_MEMORY_RECORD_LIMIT;
  const relevant = args.records
    .filter((record) => record.step_index < args.currentStepIndex)
    .slice(-limit);

  if (relevant.length === 0) return null;

  const lines = relevant.map((record) => {
    const stage = record.stage_id || `step-${record.step_index + 1}`;
    return `- [${stage}] (${record.status}) ${record.result_summary}`;
  });
  return lines.join('\n');
}
