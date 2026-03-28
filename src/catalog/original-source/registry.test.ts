import { describe, expect, it } from 'vitest';

import { listFlowSpecs } from '../flows/index.js';
import { listToolsetSpecs } from '../toolsets/index.js';
import {
  getOriginalSourceManifest,
  hasOriginalSourceManifest,
  listOriginalSourceManifests,
} from './index.js';

describe('original source manifest registry', () => {
  it('loads preserved original source manifests', () => {
    const manifests = listOriginalSourceManifests();

    expect(manifests.length).toBeGreaterThan(0);
    expect(getOriginalSourceManifest('autoresearch')).toMatchObject({
      id: 'autoresearch',
      origin: 'local-preserved-module',
    });
    expect(hasOriginalSourceManifest('autoresearch')).toBe(true);
  });

  it('resolves all toolset source module references against preserved source manifests', () => {
    for (const toolset of listToolsetSpecs()) {
      for (const sourceModuleId of toolset.sourceModuleIds || []) {
        expect(
          hasOriginalSourceManifest(sourceModuleId),
          `Missing preserved source manifest for toolset ${toolset.id} -> ${sourceModuleId}`,
        ).toBe(true);
      }
    }
  });

  it('resolves all flow source module references against preserved source manifests', () => {
    for (const flow of listFlowSpecs()) {
      for (const sourceModuleId of flow.sourceModuleIds || []) {
        expect(
          hasOriginalSourceManifest(sourceModuleId),
          `Missing preserved source manifest for flow ${flow.id} -> ${sourceModuleId}`,
        ).toBe(true);
      }
    }
  });
});
