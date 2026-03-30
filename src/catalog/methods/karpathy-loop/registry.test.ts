import { describe, expect, it } from 'vitest';

import { getAgentSpec } from '../../agents/index.js';
import {
  getKarpathyLoopMethodSpec,
  listKarpathyLoopMethodSpecs,
  resolveKarpathyLoopContracts,
} from './index.js';

describe('karpathy-loop method registry', () => {
  it('loads v1 and memory-v2 methods with preserved provenance', () => {
    const methods = listKarpathyLoopMethodSpecs();
    const ids = methods.map((method) => method.id).sort();
    expect(ids).toEqual(['karpathy_loop_memory_v2', 'karpathy_loop_v1']);

    const v1 = getKarpathyLoopMethodSpec('karpathy_loop_v1');
    const v2 = getKarpathyLoopMethodSpec('karpathy_loop_memory_v2');
    expect(v1?.sourceModuleIds).toContain('karpathy_loop');
    expect(v2?.sourceModuleIds).toEqual(
      expect.arrayContaining(['karpathy_loop', 'entireio_cli']),
    );
  });

  it('resolves default role assignments to existing catalog agents', () => {
    const method = getKarpathyLoopMethodSpec('karpathy_loop_v1');
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

  it('provides stable input/output contract defaults with info collection', () => {
    const contracts = resolveKarpathyLoopContracts();
    expect(contracts.input.evaluation.passRule).toBe('all_checks_pass');
    expect(contracts.input.safety.maxIterations).toBeGreaterThan(0);
    expect(contracts.input.memory?.enabled).toBe(true);
    expect(contracts.input.memory?.granularity).toBe('stage');
    expect(contracts.input.runSpec.timeoutSeconds).toBeGreaterThan(0);
    expect(contracts.input.infoCollection.enabled).toBe(true);
    expect(contracts.input.infoCollection.triggerAfterIteration).toBe(1);
    expect(contracts.output.finalDecision.outcome).toBe('stopped');
  });
});
