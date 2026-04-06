import { RegisteredGroup, WorkflowPlanStep } from '../types.js';
import { WorkflowRepository } from '../storage/workflows.js';

export interface QualityLoopParams {
  task: string;
  rubricPath: string;
  inputFiles: string[];
  referenceFiles: string[];
  outputDir: string;
  model?: string;
}

export interface QualityLoopResult {
  status: string;
  finalScore: number | null;
  outputFiles: string[];
  runId: string;
  error?: string;
  history: Array<{ iteration: number; total: number; verdict: string }>;
}

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
  executeQualityLoop?: (
    params: QualityLoopParams,
    onProgress: (message: string) => void,
  ) => Promise<QualityLoopResult>;
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
