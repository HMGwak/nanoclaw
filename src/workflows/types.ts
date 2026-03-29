import { RegisteredGroup, WorkflowPlanStep } from '../types.js';
import { WorkflowRepository } from '../storage/workflows.js';

export interface WorkflowEngineDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  repository?: WorkflowRepository;
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
  flowId?: string;
  stepId: string;
  stepIndex: number;
  stageId?: string;
  role: string;
  goal: string;
  acceptanceCriteria: string[] | null;
  constraints: string[] | null;
  previousStepResult?: string;
  memorySummary?: string;
}

export interface WorkflowRequest {
  title: string;
  flowId?: string;
  steps: WorkflowPlanStep[];
  sourceGroupFolder: string;
  sourceChatJid: string;
}
