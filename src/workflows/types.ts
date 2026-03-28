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
  stepId: string;
  stepIndex: number;
  role: string;
  goal: string;
  acceptanceCriteria: string[] | null;
  constraints: string[] | null;
  previousStepResult?: string;
}

export interface WorkflowRequest {
  title: string;
  steps: WorkflowPlanStep[];
  sourceGroupFolder: string;
  sourceChatJid: string;
}
