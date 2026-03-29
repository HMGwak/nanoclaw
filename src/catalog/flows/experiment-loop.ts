import { FlowSpec } from './types.js';

export const EXPERIMENT_LOOP_FLOW: FlowSpec = {
  id: 'experiment-loop',
  title: 'Experiment loop with independent verification',
  description:
    'Service-neutral iteration loop for baseline capture, change execution, independent verification, and keep/discard decisions.',
  sourceModuleIds: ['autoresearch'],
  stages: [
    {
      id: 'baseline',
      title: 'Baseline',
      description: 'Capture the starting state and baseline evidence.',
    },
    {
      id: 'change',
      title: 'Change',
      description: 'Apply one constrained change based on the current plan.',
    },
    {
      id: 'run',
      title: 'Run',
      description: 'Execute the run spec and collect artifacts.',
    },
    {
      id: 'verify',
      title: 'Verify',
      description: 'Evaluate results independently against explicit criteria.',
    },
    {
      id: 'decide',
      title: 'Decide',
      description: 'Choose keep or discard according to decision policy.',
    },
    {
      id: 'report',
      title: 'Report',
      description: 'Publish the iteration summary and final decision.',
    },
  ],
};
