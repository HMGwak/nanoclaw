export type KarpathyLoopDecision = 'keep' | 'discard' | 'stopped';

export interface KarpathyLoopRoleAssignments {
  planner: string;
  executor: string;
  verifier: string;
  judge: string;
}

export interface KarpathyLoopRunSpec {
  command: string;
  timeoutSeconds: number;
  workingDirectory?: string;
}

export interface KarpathyLoopEvaluationSpec {
  criteria: string[];
  commands: string[];
  passRule: 'all_checks_pass';
}

export interface KarpathyLoopDecisionPolicy {
  keepWhen: string;
  discardWhen: string;
  tieBreaker: string;
}

export interface KarpathyLoopSafetySpec {
  maxIterations: number;
  failureStreakLimit: number;
  blockedCommands: string[];
}

export interface KarpathyLoopMemorySpec {
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

export type KarpathyLoopEvidenceType = 'web' | 'file' | 'memory' | 'artifact';

export interface KarpathyLoopInfoCollectionSpec {
  enabled: boolean;
  triggerAfterIteration: number;
  requiredEvidenceTypes: KarpathyLoopEvidenceType[];
  guidance: string;
}

export interface KarpathyLoopInputContract {
  objective: string;
  scope: string[];
  plan: string;
  runSpec: KarpathyLoopRunSpec;
  evaluation: KarpathyLoopEvaluationSpec;
  decisionPolicy: KarpathyLoopDecisionPolicy;
  safety: KarpathyLoopSafetySpec;
  memory?: KarpathyLoopMemorySpec;
  infoCollection: KarpathyLoopInfoCollectionSpec;
}

export interface KarpathyLoopIterationRecord {
  index: number;
  changeSummary: string;
  runResult: string;
  verificationResult: string;
  decision: 'keep' | 'discard';
  reason: string;
  artifacts: string[];
  collectionSummary?: string;
  collectedEvidenceRefs?: string[];
}

export interface KarpathyLoopOutputContract {
  baseline: {
    summary: string;
    artifacts: string[];
  };
  iterations: KarpathyLoopIterationRecord[];
  finalDecision: {
    outcome: KarpathyLoopDecision;
    rationale: string;
    selectedIteration: number | null;
  };
  artifacts: string[];
}

export interface KarpathyLoopMethodSpec {
  id: string;
  title: string;
  description: string;
  sourceModuleIds?: string[];
  defaultRoleAssignments: KarpathyLoopRoleAssignments;
  memoryPolicy?: KarpathyLoopMemorySpec;
  infoCollectionPolicy: KarpathyLoopInfoCollectionSpec;
}
