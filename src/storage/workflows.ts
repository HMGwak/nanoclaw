import type Database from 'better-sqlite3';

import {
  WorkflowPlanStep,
  WorkflowRun,
  WorkflowStatus,
  WorkflowStepRun,
} from '../types.js';

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createWorkflowRepository(db: Database.Database) {
  return {
    createWorkflow(data: {
      title: string;
      sourceGroupFolder: string;
      sourceChatJid: string;
      planSteps: WorkflowPlanStep[];
    }): WorkflowRun {
      const id = genId('wf');
      const now = new Date().toISOString();
      const participants = JSON.stringify([
        ...new Set(data.planSteps.map((s) => s.assignee)),
      ]);
      const planJson = JSON.stringify(data.planSteps);

      db.prepare(
        `INSERT INTO workflow_runs (id, title, source_group_folder, source_chat_jid, participants, status, current_step_index, plan_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending_confirmation', 0, ?, ?, ?)`,
      ).run(
        id,
        data.title,
        data.sourceGroupFolder,
        data.sourceChatJid,
        participants,
        planJson,
        now,
        now,
      );

      return this.getWorkflow(id)!;
    },

    getWorkflow(id: string): WorkflowRun | undefined {
      return db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as
        | WorkflowRun
        | undefined;
    },

    updateWorkflow(
      id: string,
      updates: Partial<
        Pick<WorkflowRun, 'status' | 'current_step_index' | 'discord_thread_id'>
      >,
    ): void {
      const now = new Date().toISOString();
      const sets: string[] = ['updated_at = ?'];
      const vals: unknown[] = [now];

      if (updates.status !== undefined) {
        sets.push('status = ?');
        vals.push(updates.status);
      }
      if (updates.current_step_index !== undefined) {
        sets.push('current_step_index = ?');
        vals.push(updates.current_step_index);
      }
      if (updates.discord_thread_id !== undefined) {
        sets.push('discord_thread_id = ?');
        vals.push(updates.discord_thread_id);
      }

      vals.push(id);
      db.prepare(
        `UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`,
      ).run(...vals);
    },

    getWorkflowsByStatus(status: WorkflowStatus): WorkflowRun[] {
      return db
        .prepare('SELECT * FROM workflow_runs WHERE status = ?')
        .all(status) as WorkflowRun[];
    },

    createWorkflowStep(data: {
      workflowId: string;
      stepIndex: number;
      assigneeGroupFolder: string;
      assigneeChatJid: string;
      goal: string;
      acceptanceCriteria?: string[];
      constraints?: string[];
    }): WorkflowStepRun {
      const id = genId('ws');
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO workflow_step_runs (id, workflow_id, step_index, assignee_group_folder, assignee_chat_jid, goal, acceptance_criteria, constraints, status, retry_count, max_retries, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 2, ?, ?)`,
      ).run(
        id,
        data.workflowId,
        data.stepIndex,
        data.assigneeGroupFolder,
        data.assigneeChatJid,
        data.goal,
        data.acceptanceCriteria
          ? JSON.stringify(data.acceptanceCriteria)
          : null,
        data.constraints ? JSON.stringify(data.constraints) : null,
        now,
        now,
      );

      return this.getWorkflowStep(id)!;
    },

    getWorkflowStep(id: string): WorkflowStepRun | undefined {
      return db
        .prepare('SELECT * FROM workflow_step_runs WHERE id = ?')
        .get(id) as WorkflowStepRun | undefined;
    },

    getWorkflowSteps(workflowId: string): WorkflowStepRun[] {
      return db
        .prepare(
          'SELECT * FROM workflow_step_runs WHERE workflow_id = ? ORDER BY step_index ASC',
        )
        .all(workflowId) as WorkflowStepRun[];
    },

    updateWorkflowStep(
      id: string,
      updates: Partial<
        Pick<
          WorkflowStepRun,
          | 'status'
          | 'claimed_at'
          | 'lease_expires_at'
          | 'result_summary'
          | 'retry_count'
        >
      >,
    ): void {
      const now = new Date().toISOString();
      const sets: string[] = ['updated_at = ?'];
      const vals: unknown[] = [now];

      if (updates.status !== undefined) {
        sets.push('status = ?');
        vals.push(updates.status);
      }
      if (updates.claimed_at !== undefined) {
        sets.push('claimed_at = ?');
        vals.push(updates.claimed_at);
      }
      if (updates.lease_expires_at !== undefined) {
        sets.push('lease_expires_at = ?');
        vals.push(updates.lease_expires_at);
      }
      if (updates.result_summary !== undefined) {
        sets.push('result_summary = ?');
        vals.push(updates.result_summary);
      }
      if (updates.retry_count !== undefined) {
        sets.push('retry_count = ?');
        vals.push(updates.retry_count);
      }

      vals.push(id);
      db.prepare(
        `UPDATE workflow_step_runs SET ${sets.join(', ')} WHERE id = ?`,
      ).run(...vals);
    },

    getExpiredLeases(): WorkflowStepRun[] {
      const now = new Date().toISOString();
      return db
        .prepare(
          `SELECT * FROM workflow_step_runs
           WHERE status IN ('claimed', 'running')
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at < ?`,
        )
        .all(now) as WorkflowStepRun[];
    },

    getActiveWorkflowContainerCount(): number {
      const row = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM workflow_step_runs WHERE status IN ('claimed', 'running')`,
        )
        .get() as { cnt: number };
      return row.cnt;
    },
  };
}

export type WorkflowRepository = ReturnType<typeof createWorkflowRepository>;
