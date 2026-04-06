import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GROUPS_DIR } from './config.js';
import {
  _initTestDatabase,
  _closeDatabase,
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  createWorkflowStep,
  getWorkflowSteps,
  updateWorkflowStep,
  getExpiredLeases,
  getActiveWorkflowContainerCount,
  getWorkflowsByStatus,
} from './db.js';
import { WorkflowEngine, WorkflowEngineDeps } from './workflow-engine.js';
import type { WorkflowPlanStep } from './types.js';

// Mock registered groups
const mockGroups = {
  'dc:1234:planning': {
    name: '기획실',
    folder: 'discord_planning',
    trigger: '@기획실',
    added_at: '2026-01-01T00:00:00Z',
    isMain: false,
  },
  'dc:5678:workshop': {
    name: '작업실',
    folder: 'discord_workshop',
    trigger: '@작업실',
    added_at: '2026-01-01T00:00:00Z',
    isMain: false,
  },
  'dc:9999:secretary': {
    name: '비서실',
    folder: 'discord_secretary',
    trigger: '@비서실',
    added_at: '2026-01-01T00:00:00Z',
    isMain: true,
  },
};

function createMockDeps(): WorkflowEngineDeps & {
  sentMessages: Array<{ jid: string; text: string }>;
  enqueuedSteps: Array<{ groupJid: string; stepId: string; prompt: string }>;
  closedStdins: string[];
} {
  const sentMessages: Array<{ jid: string; text: string }> = [];
  const enqueuedSteps: Array<{
    groupJid: string;
    stepId: string;
    prompt: string;
  }> = [];
  const closedStdins: string[] = [];

  return {
    sentMessages,
    enqueuedSteps,
    closedStdins,
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
    },
    registeredGroups: () => mockGroups,
    enqueueWorkflowStep: (groupJid, stepId, prompt, _context) => {
      enqueuedSteps.push({ groupJid, stepId, prompt });
    },
    closeStdin: (groupJid) => {
      closedStdins.push(groupJid);
    },
  };
}

describe('Workflow DB CRUD', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('creates a workflow with participants', () => {
    const wf = createWorkflow({
      title: 'Test Workflow',
      sourceGroupFolder: 'discord_planning',
      sourceChatJid: 'dc:1234:planning',
      planSteps: [
        {
          step_index: 0,
          assignee: 'discord_workshop',
          goal: 'Build feature',
          acceptance_criteria: ['Tests pass'],
          constraints: ['No API changes'],
        },
      ],
    });

    expect(wf.id).toMatch(/^wf-/);
    expect(wf.title).toBe('Test Workflow');
    expect(wf.status).toBe('pending_confirmation');
    expect(JSON.parse(wf.participants!)).toEqual(['discord_workshop']);
    expect(JSON.parse(wf.plan_json!)).toHaveLength(1);
  });

  it('updates workflow status', () => {
    const wf = createWorkflow({
      title: 'Test',
      sourceGroupFolder: 'discord_planning',
      sourceChatJid: 'dc:1234',
      planSteps: [
        { step_index: 0, assignee: 'discord_workshop', goal: 'Do it' },
      ],
    });

    updateWorkflow(wf.id, { status: 'running' });
    const updated = getWorkflow(wf.id)!;
    expect(updated.status).toBe('running');
  });

  it('creates workflow steps with acceptance criteria', () => {
    const wf = createWorkflow({
      title: 'Test',
      sourceGroupFolder: 'discord_planning',
      sourceChatJid: 'dc:1234',
      planSteps: [
        { step_index: 0, assignee: 'discord_workshop', goal: 'Step 1' },
      ],
    });

    const step = createWorkflowStep({
      workflowId: wf.id,
      stepIndex: 0,
      assigneeGroupFolder: 'discord_workshop',
      assigneeChatJid: 'dc:5678:workshop',
      goal: 'Build API',
      acceptanceCriteria: ['Tests pass', 'Docs updated'],
      constraints: ['No breaking changes'],
    });

    expect(step.id).toMatch(/^ws-/);
    expect(step.status).toBe('pending');
    expect(step.retry_count).toBe(0);
    expect(step.max_retries).toBe(2);
    expect(JSON.parse(step.acceptance_criteria!)).toEqual([
      'Tests pass',
      'Docs updated',
    ]);
  });

  it('gets workflow steps ordered by step_index', () => {
    const wf = createWorkflow({
      title: 'Multi-step',
      sourceGroupFolder: 'discord_planning',
      sourceChatJid: 'dc:1234',
      planSteps: [
        { step_index: 0, assignee: 'discord_workshop', goal: 'A' },
        { step_index: 1, assignee: 'discord_planning', goal: 'B' },
      ],
    });

    createWorkflowStep({
      workflowId: wf.id,
      stepIndex: 1,
      assigneeGroupFolder: 'discord_planning',
      assigneeChatJid: 'dc:1234:planning',
      goal: 'Review',
    });
    createWorkflowStep({
      workflowId: wf.id,
      stepIndex: 0,
      assigneeGroupFolder: 'discord_workshop',
      assigneeChatJid: 'dc:5678:workshop',
      goal: 'Build',
    });

    const steps = getWorkflowSteps(wf.id);
    expect(steps).toHaveLength(2);
    expect(steps[0].step_index).toBe(0);
    expect(steps[1].step_index).toBe(1);
  });

  it('detects expired leases', () => {
    const wf = createWorkflow({
      title: 'Lease test',
      sourceGroupFolder: 'discord_planning',
      sourceChatJid: 'dc:1234',
      planSteps: [
        { step_index: 0, assignee: 'discord_workshop', goal: 'Work' },
      ],
    });

    const step = createWorkflowStep({
      workflowId: wf.id,
      stepIndex: 0,
      assigneeGroupFolder: 'discord_workshop',
      assigneeChatJid: 'dc:5678:workshop',
      goal: 'Work',
    });

    // Set lease in the past
    const past = new Date(Date.now() - 60000).toISOString();
    updateWorkflowStep(step.id, {
      status: 'running',
      claimed_at: past,
      lease_expires_at: past,
    });

    const expired = getExpiredLeases();
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe(step.id);
  });

  it('counts active workflow containers', () => {
    const wf = createWorkflow({
      title: 'Count test',
      sourceGroupFolder: 'discord_planning',
      sourceChatJid: 'dc:1234',
      planSteps: [
        { step_index: 0, assignee: 'discord_workshop', goal: 'Work' },
      ],
    });

    const step = createWorkflowStep({
      workflowId: wf.id,
      stepIndex: 0,
      assigneeGroupFolder: 'discord_workshop',
      assigneeChatJid: 'dc:5678:workshop',
      goal: 'Work',
    });

    expect(getActiveWorkflowContainerCount()).toBe(0);

    updateWorkflowStep(step.id, { status: 'running' });
    expect(getActiveWorkflowContainerCount()).toBe(1);

    updateWorkflowStep(step.id, { status: 'completed' });
    expect(getActiveWorkflowContainerCount()).toBe(0);
  });

  it('queries workflows by status', () => {
    createWorkflow({
      title: 'WF1',
      sourceGroupFolder: 'discord_planning',
      sourceChatJid: 'dc:1234',
      planSteps: [{ step_index: 0, assignee: 'discord_workshop', goal: 'A' }],
    });
    const wf2 = createWorkflow({
      title: 'WF2',
      sourceGroupFolder: 'discord_planning',
      sourceChatJid: 'dc:1234',
      planSteps: [{ step_index: 0, assignee: 'discord_workshop', goal: 'B' }],
    });
    updateWorkflow(wf2.id, { status: 'running' });

    expect(getWorkflowsByStatus('pending_confirmation')).toHaveLength(1);
    expect(getWorkflowsByStatus('running')).toHaveLength(1);
  });
});

describe('WorkflowEngine', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('requestWorkflow creates workflow and sends confirmation', async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);

    const planSteps: WorkflowPlanStep[] = [
      {
        step_index: 0,
        assignee: 'discord_workshop',
        goal: 'Build the feature',
        acceptance_criteria: ['Tests pass'],
        stage_id: 'change',
      },
    ];

    const wf = await engine.requestWorkflow(
      'Test Feature',
      planSteps,
      'discord_planning',
      'dc:1234:planning',
      'test-flow',
    );

    expect(wf.id).toMatch(/^wf-/);

    // Check DB state
    const dbWf = getWorkflow(wf.id)!;
    expect(dbWf.status).toBe('awaiting_confirmation');
    expect(dbWf.flow_id).toBe('test-flow');

    // Check steps created
    const steps = getWorkflowSteps(wf.id);
    expect(steps).toHaveLength(1);
    expect(steps[0].goal).toBe('Build the feature');
    expect(steps[0].stage_id).toBe('change');

    // Check confirmation message sent
    expect(deps.sentMessages).toHaveLength(1);
    expect(deps.sentMessages[0].jid).toBe('dc:1234:planning');
    expect(deps.sentMessages[0].text).toContain('워크플로우 요청');

    const sourceRunSnapshot = path.join(
      GROUPS_DIR,
      'discord_planning',
      'runs',
      wf.id,
      'workflow.json',
    );
    const assigneeRunSnapshot = path.join(
      GROUPS_DIR,
      'discord_workshop',
      'runs',
      wf.id,
      'workflow.json',
    );
    expect(fs.existsSync(sourceRunSnapshot)).toBe(true);
    expect(fs.existsSync(assigneeRunSnapshot)).toBe(true);
  });

  it('requestWorkflow resolves assignee display names to registered folders', async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);

    const wf = await engine.requestWorkflow(
      'Display Name Mapping',
      [
        {
          step_index: 0,
          assignee: '작업실',
          goal: '폴더 매핑 확인',
        },
      ],
      'discord_planning',
      'dc:1234:planning',
      'test-flow',
    );

    const steps = getWorkflowSteps(wf.id);
    expect(steps).toHaveLength(1);
    expect(steps[0].assignee_group_folder).toBe('discord_workshop');
  });

  it('requestWorkflow resolves compact department aliases when unambiguous', async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);

    const wf = await engine.requestWorkflow(
      'Compact Alias Mapping',
      [
        {
          step_index: 0,
          assignee: '기획',
          goal: '축약어 매핑 확인',
        },
      ],
      'discord_planning',
      'dc:1234:planning',
      'test-flow',
    );

    const steps = getWorkflowSteps(wf.id);
    expect(steps).toHaveLength(1);
    expect(steps[0].assignee_group_folder).toBe('discord_planning');
  });

  it('requestWorkflow resolves slash-separated assignee aliases when one target matches', async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);

    const wf = await engine.requestWorkflow(
      'Compound Alias Mapping',
      [
        {
          step_index: 0,
          assignee: '기획/개발',
          goal: '복합 축약어 매핑 확인',
        },
      ],
      'discord_planning',
      'dc:1234:planning',
      'test-flow',
    );

    const steps = getWorkflowSteps(wf.id);
    expect(steps).toHaveLength(1);
    expect(steps[0].assignee_group_folder).toBe('discord_planning');
  });

  it('confirmWorkflow starts first step', async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);

    const wf = await engine.requestWorkflow(
      'Test',
      [
        {
          step_index: 0,
          assignee: 'discord_workshop',
          goal: 'Build it',
        },
      ],
      'discord_planning',
      'dc:1234:planning',
    );

    await engine.confirmWorkflow(wf.id);

    // Check workflow is running
    const dbWf = getWorkflow(wf.id)!;
    expect(dbWf.status).toBe('running');

    // Check step was enqueued
    expect(deps.enqueuedSteps).toHaveLength(1);
    expect(deps.enqueuedSteps[0].groupJid).toBe('dc:5678:workshop');

    // Check step status
    const steps = getWorkflowSteps(wf.id);
    expect(steps[0].status).toBe('claimed');
    expect(steps[0].claimed_at).toBeTruthy();
    expect(steps[0].lease_expires_at).toBeTruthy();
  });

  it('autoStart starts workflow immediately and posts progress updates', async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);

    const wf = await engine.requestWorkflow(
      'Auto Start',
      [
        {
          step_index: 0,
          assignee: 'discord_workshop',
          goal: 'Build immediately',
          stage_id: 'change',
        },
      ],
      'discord_planning',
      'dc:1234:planning',
      'test-flow',
      { autoStart: true },
    );

    expect(getWorkflow(wf.id)!.status).toBe('running');
    expect(deps.enqueuedSteps).toHaveLength(1);
    expect(
      deps.sentMessages.some((m) => m.text.includes('워크플로우 시작')),
    ).toBe(true);
    expect(
      deps.sentMessages.some((m) => m.text.includes('진행: Step 1/1 시작')),
    ).toBe(true);
  });

  it('onStepCompleted advances to next step', async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);

    const wf = await engine.requestWorkflow(
      'Multi-step',
      [
        {
          step_index: 0,
          assignee: 'discord_workshop',
          goal: 'Step 1',
          stage_id: 'baseline',
        },
        {
          step_index: 1,
          assignee: 'discord_planning',
          goal: 'Step 2',
          stage_id: 'change',
        },
      ],
      'discord_planning',
      'dc:1234:planning',
      'test-flow',
    );

    await engine.confirmWorkflow(wf.id);
    deps.enqueuedSteps.length = 0; // reset

    await engine.onStepCompleted(wf.id, 0, 'Step 1 done');

    // Check step 0 completed
    const steps = getWorkflowSteps(wf.id);
    expect(steps[0].status).toBe('completed');
    expect(steps[0].result_summary).toBe('Step 1 done');

    // Check step 1 was enqueued
    expect(deps.enqueuedSteps).toHaveLength(1);
    expect(deps.enqueuedSteps[0].groupJid).toBe('dc:1234:planning');
    expect(deps.enqueuedSteps[0].prompt).toContain('Flow ID: test-flow');
    expect(deps.enqueuedSteps[0].prompt).toContain('Stage ID: change');
    expect(deps.enqueuedSteps[0].prompt).toContain('누적 메모리 요약');
    expect(deps.enqueuedSteps[0].prompt).toContain('Step 1 done');

    const memoryFile = path.join(
      GROUPS_DIR,
      'discord_planning',
      'runs',
      wf.id,
      'memory',
      'stage-events.jsonl',
    );
    expect(fs.existsSync(memoryFile)).toBe(true);
  });

  it('onStepCompleted completes workflow on last step', async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);

    const wf = await engine.requestWorkflow(
      'Single step',
      [{ step_index: 0, assignee: 'discord_workshop', goal: 'Do it' }],
      'discord_planning',
      'dc:1234:planning',
    );

    await engine.confirmWorkflow(wf.id);
    await engine.onStepCompleted(wf.id, 0, 'All done');

    const dbWf = getWorkflow(wf.id)!;
    expect(dbWf.status).toBe('completed');

    // Completion message sent
    const completionMsg = deps.sentMessages.find((m) =>
      m.text.includes('완료되었습니다'),
    );
    expect(completionMsg).toBeTruthy();
  });

  it('onStepFailed retries within max_retries', async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);

    const wf = await engine.requestWorkflow(
      'Retry test',
      [{ step_index: 0, assignee: 'discord_workshop', goal: 'Flaky task' }],
      'discord_planning',
      'dc:1234:planning',
    );

    await engine.confirmWorkflow(wf.id);
    deps.enqueuedSteps.length = 0;

    // First failure -> retry
    await engine.onStepFailed(wf.id, 0, 'Timeout');

    const steps = getWorkflowSteps(wf.id);
    expect(steps[0].retry_count).toBe(1);

    // Should re-enqueue
    expect(deps.enqueuedSteps).toHaveLength(1);

    // Workflow still running
    expect(getWorkflow(wf.id)!.status).toBe('running');
  });

  it('onStepFailed fails workflow after max_retries', async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);

    const wf = await engine.requestWorkflow(
      'Fail test',
      [{ step_index: 0, assignee: 'discord_workshop', goal: 'Bad task' }],
      'discord_planning',
      'dc:1234:planning',
    );

    await engine.confirmWorkflow(wf.id);

    // Exhaust retries (max_retries = 2)
    await engine.onStepFailed(wf.id, 0, 'Error 1');
    await engine.onStepFailed(wf.id, 0, 'Error 2');
    await engine.onStepFailed(wf.id, 0, 'Error 3');

    const dbWf = getWorkflow(wf.id)!;
    expect(dbWf.status).toBe('failed');

    // Failure message sent
    const failMsg = deps.sentMessages.find((m) => m.text.includes('실패'));
    expect(failMsg).toBeTruthy();
  });

  it('cancelWorkflow stops running steps', async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);

    const wf = await engine.requestWorkflow(
      'Cancel test',
      [
        { step_index: 0, assignee: 'discord_workshop', goal: 'Long task' },
        { step_index: 1, assignee: 'discord_planning', goal: 'Review' },
      ],
      'discord_planning',
      'dc:1234:planning',
    );

    await engine.confirmWorkflow(wf.id);
    await engine.cancelWorkflow(wf.id, 'discord_planning');

    const dbWf = getWorkflow(wf.id)!;
    expect(dbWf.status).toBe('cancelled');

    // Running step should be skipped
    const steps = getWorkflowSteps(wf.id);
    expect(steps.every((s) => s.status === 'skipped')).toBe(true);

    // closeStdin called for running step
    expect(deps.closedStdins).toContain('dc:5678:workshop');

    // Cancel message sent
    const cancelMsg = deps.sentMessages.find((m) =>
      m.text.includes('취소되었습니다'),
    );
    expect(cancelMsg).toBeTruthy();
  });

  it('ignores step results for cancelled workflows', async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);

    const wf = await engine.requestWorkflow(
      'Guard test',
      [{ step_index: 0, assignee: 'discord_workshop', goal: 'Task' }],
      'discord_planning',
      'dc:1234:planning',
    );

    await engine.confirmWorkflow(wf.id);
    await engine.cancelWorkflow(wf.id);

    // Try to complete the cancelled step — should be no-op
    const msgCountBefore = deps.sentMessages.length;
    await engine.onStepCompleted(wf.id, 0, 'Late result');

    expect(getWorkflow(wf.id)!.status).toBe('cancelled');
    // No new completion message
    const completionMsgs = deps.sentMessages
      .slice(msgCountBefore)
      .filter((m) => m.text.includes('완료'));
    expect(completionMsgs).toHaveLength(0);
  });

  it('rejects unauthorized cancel', async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);

    const wf = await engine.requestWorkflow(
      'Auth test',
      [{ step_index: 0, assignee: 'discord_workshop', goal: 'Task' }],
      'discord_planning',
      'dc:1234:planning',
    );

    await engine.confirmWorkflow(wf.id);

    // Try to cancel from non-participant group
    await engine.cancelWorkflow(wf.id, 'discord_random');

    // Should still be running
    expect(getWorkflow(wf.id)!.status).toBe('running');
  });
});
