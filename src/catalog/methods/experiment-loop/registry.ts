import {
  ExperimentLoopInputContract,
  ExperimentLoopMethodSpec,
  ExperimentLoopOutputContract,
} from './types.js';

const EXPERIMENT_LOOP_METHODS: Record<string, ExperimentLoopMethodSpec> = {
  experiment_loop_v1: {
    id: 'experiment_loop_v1',
    title: 'Experiment Loop v1',
    description:
      'Baseline-first iteration loop with execution, independent verification, and keep/discard judgment.',
    sourceModuleIds: ['autoresearch'],
    defaultRoleAssignments: {
      planner: 'openai_gpt54_planner',
      executor: 'openai_gpt54_generalist',
      verifier: 'openai_gpt54_reviewer',
      judge: 'openai_gpt54_reviewer',
    },
  },
  experiment_loop_memory_v2: {
    id: 'experiment_loop_memory_v2',
    title: 'Experiment Loop Memory v2',
    description:
      'Stage-level experiment loop with append-only memory trail and bounded memory injection into subsequent steps.',
    sourceModuleIds: ['autoresearch', 'entireio_cli'],
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
  },
};

export function listExperimentLoopMethodSpecs(): ExperimentLoopMethodSpec[] {
  return Object.values(EXPERIMENT_LOOP_METHODS);
}

export function getExperimentLoopMethodSpec(
  id: string,
): ExperimentLoopMethodSpec | null {
  return EXPERIMENT_LOOP_METHODS[id] || null;
}

export function resolveExperimentLoopContracts(): {
  input: ExperimentLoopInputContract;
  output: ExperimentLoopOutputContract;
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
