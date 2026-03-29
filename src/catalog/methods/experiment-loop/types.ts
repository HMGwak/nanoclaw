export type ExperimentDecision = 'keep' | 'discard' | 'stopped';

export interface ExperimentLoopRoleAssignments {
  planner: string;
  executor: string;
  verifier: string;
  judge: string;
}

export interface ExperimentRunSpec {
  command: string;
  timeoutSeconds: number;
  workingDirectory?: string;
}

export interface ExperimentEvaluationSpec {
  criteria: string[];
  commands: string[];
  passRule: 'all_checks_pass';
}

export interface ExperimentDecisionPolicy {
  keepWhen: string;
  discardWhen: string;
  tieBreaker: string;
}

export interface ExperimentSafetySpec {
  maxIterations: number;
  failureStreakLimit: number;
  blockedCommands: string[];
}

export interface ExperimentMemorySpec {
  enabled: boolean;
  granularity: 'stage';
  persistence: {
    mode: 'file_first_jsonl';
    pathPattern: 'groups/<group>/runs/<workflow-id>/memory/*.jsonl';
  };
  promptInjection: {
    enabled: boolean;
    maxRecords: number;
  };
}

export interface ExperimentLoopInputContract {
  objective: string;
  scope: string[];
  plan: string;
  runSpec: ExperimentRunSpec;
  evaluation: ExperimentEvaluationSpec;
  decisionPolicy: ExperimentDecisionPolicy;
  safety: ExperimentSafetySpec;
  memory?: ExperimentMemorySpec;
}

export interface ExperimentLoopIterationRecord {
  index: number;
  changeSummary: string;
  runResult: string;
  verificationResult: string;
  decision: 'keep' | 'discard';
  reason: string;
  artifacts: string[];
}

export interface ExperimentLoopOutputContract {
  baseline: {
    summary: string;
    artifacts: string[];
  };
  iterations: ExperimentLoopIterationRecord[];
  finalDecision: {
    outcome: ExperimentDecision;
    rationale: string;
    selectedIteration: number | null;
  };
  artifacts: string[];
}

export interface ExperimentLoopMethodSpec {
  id: string;
  title: string;
  description: string;
  sourceModuleIds?: string[];
  defaultRoleAssignments: ExperimentLoopRoleAssignments;
  memoryPolicy?: ExperimentMemorySpec;
}
