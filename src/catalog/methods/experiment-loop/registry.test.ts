import { describe, expect, it } from 'vitest';

import { getAgentSpec } from '../../agents/index.js';
import {
  getExperimentLoopMethodSpec,
  listExperimentLoopMethodSpecs,
  resolveExperimentLoopContracts,
} from './index.js';

describe('experiment-loop method registry', () => {
  it('loads v1 and memory-v2 methods with preserved provenance', () => {
    const methods = listExperimentLoopMethodSpecs();
    const ids = methods.map((method) => method.id).sort();
    expect(ids).toEqual(['experiment_loop_memory_v2', 'experiment_loop_v1']);

    const v1 = getExperimentLoopMethodSpec('experiment_loop_v1');
    const v2 = getExperimentLoopMethodSpec('experiment_loop_memory_v2');
    expect(v1?.sourceModuleIds).toContain('autoresearch');
    expect(v2?.sourceModuleIds).toEqual(
      expect.arrayContaining(['autoresearch', 'entireio_cli']),
    );
  });

  it('resolves default role assignments to existing catalog agents', () => {
    const method = getExperimentLoopMethodSpec('experiment_loop_v1');
    expect(method).not.toBeNull();
    if (!method) return;

    const roleAgentIds = Object.values(method.defaultRoleAssignments);
    for (const agentId of roleAgentIds) {
      expect(
        getAgentSpec(agentId),
        `Missing catalog agent for role assignment: ${agentId}`,
      ).not.toBeNull();
    }
  });

  it('provides stable input/output contract defaults', () => {
    const contracts = resolveExperimentLoopContracts();
    expect(contracts.input.evaluation.passRule).toBe('all_checks_pass');
    expect(contracts.input.safety.maxIterations).toBeGreaterThan(0);
    expect(contracts.input.memory?.enabled).toBe(true);
    expect(contracts.input.memory?.granularity).toBe('stage');
    expect(contracts.input.runSpec.timeoutSeconds).toBeGreaterThan(0);
    expect(contracts.output.finalDecision.outcome).toBe('stopped');
  });
});
