import {
  KarpathyLoopInputContract,
  KarpathyLoopInfoCollectionSpec,
  KarpathyLoopMethodSpec,
  KarpathyLoopOutputContract,
} from './types.js';

const DEFAULT_INFO_COLLECTION_POLICY: KarpathyLoopInfoCollectionSpec = {
  enabled: true,
  triggerAfterIteration: 1,
  requiredEvidenceTypes: ['web', 'memory', 'artifact'],
  guidance:
    'After the first keep/discard decision, collect missing evidence before continuing to the next iteration.',
};

const KARPATHY_LOOP_METHODS: Record<string, KarpathyLoopMethodSpec> = {
  karpathy_loop_v1: {
    id: 'karpathy_loop_v1',
    title: 'Karpathy Loop v1',
    description:
      'Baseline-first iteration loop with execution, independent verification, keep/discard judgment, and post-round information collection.',
    sourceModuleIds: ['karpathy_loop'],
    defaultRoleAssignments: {
      planner: 'openai_gpt54_planner',
      executor: 'openai_gpt54_generalist',
      verifier: 'openai_gpt54_reviewer',
      judge: 'openai_gpt54_reviewer',
    },
    infoCollectionPolicy: DEFAULT_INFO_COLLECTION_POLICY,
  },
  karpathy_loop_memory_v2: {
    id: 'karpathy_loop_memory_v2',
    title: 'Karpathy Loop Memory v2',
    description:
      'Stage-level Karpathy loop with append-only memory trail, bounded memory injection, and post-round information collection.',
    sourceModuleIds: ['karpathy_loop', 'entireio_cli'],
    defaultRoleAssignments: {
      planner: 'openai_gpt54_planner',
      executor: 'openai_gpt54_generalist',
      verifier: 'openai_gpt54_reviewer',
      judge: 'openai_gpt54_reviewer',
    },
    memoryPolicy: {
      enabled: true,
      granularity: 'stage',
      persistence: {
        mode: 'file_first_jsonl',
        pathPattern: 'groups/<group>/runs/<workflow-id>/memory/*.jsonl',
      },
      promptInjection: {
        enabled: true,
        maxRecords: 5,
      },
    },
    infoCollectionPolicy: DEFAULT_INFO_COLLECTION_POLICY,
  },
};

export function listKarpathyLoopMethodSpecs(): KarpathyLoopMethodSpec[] {
  return Object.values(KARPATHY_LOOP_METHODS);
}

export function getKarpathyLoopMethodSpec(
  id: string,
): KarpathyLoopMethodSpec | null {
  return KARPATHY_LOOP_METHODS[id] || null;
}

export function resolveKarpathyLoopContracts(): {
  input: KarpathyLoopInputContract;
  output: KarpathyLoopOutputContract;
} {
  return {
    input: {
      objective: '',
      scope: [],
      plan: '',
      runSpec: {
        command: '',
        timeoutSeconds: 600,
      },
      evaluation: {
        criteria: [],
        commands: [],
        passRule: 'all_checks_pass',
      },
      decisionPolicy: {
        keepWhen: 'all evaluation checks pass and objective trend improves',
        discardWhen: 'evaluation fails or objective regresses',
        tieBreaker: 'prefer simpler change set when outcomes are equivalent',
      },
      safety: {
        maxIterations: 5,
        failureStreakLimit: 2,
        blockedCommands: ['rm -rf', 'git reset --hard', 'git clean -fd'],
      },
      memory: {
        enabled: true,
        granularity: 'stage',
        persistence: {
          mode: 'file_first_jsonl',
          pathPattern: 'groups/<group>/runs/<workflow-id>/memory/*.jsonl',
        },
        promptInjection: {
          enabled: true,
          maxRecords: 5,
        },
      },
      infoCollection: DEFAULT_INFO_COLLECTION_POLICY,
    },
    output: {
      baseline: {
        summary: '',
        artifacts: [],
      },
      iterations: [],
      finalDecision: {
        outcome: 'stopped',
        rationale: '',
        selectedIteration: null,
      },
      artifacts: [],
    },
  };
}
