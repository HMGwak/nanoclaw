import { FlowSpec } from './types.js';

export const KARPATHY_LOOP_FLOW: FlowSpec = {
  id: 'karpathy-loop',
  title: 'Karpathy loop with independent verification',
  description:
    'Service-neutral iteration loop for baseline capture, change execution, independent verification, keep/discard decisions, and post-round information collection.',
  sourceModuleIds: ['karpathy_loop'],
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
      id: 'collect',
      title: 'Collect',
      description:
        'Collect additional information after the first decision before the next round.',
    },
    {
      id: 'report',
      title: 'Report',
      description: 'Publish the iteration summary and final decision.',
    },
  ],
};
