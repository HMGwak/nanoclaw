import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  listDebateModeSpecs,
  listDebateProtocolSpecs,
} from '../methods/debate/index.js';
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
    expect(getOriginalSourceManifest('karpathy_loop')).toMatchObject({
      id: 'karpathy_loop',
      origin: 'github-upstream-derived',
    });
    expect(hasOriginalSourceManifest('karpathy_loop')).toBe(true);
    expect(getOriginalSourceManifest('entireio_cli')).toMatchObject({
      id: 'entireio_cli',
      origin: 'github-upstream-derived',
    });
    expect(
      getOriginalSourceManifest('cloudflare_browser_rendering'),
    ).toMatchObject({
      id: 'cloudflare_browser_rendering',
      origin: 'vendor-docs-derived',
    });
    expect(getOriginalSourceManifest('vercel_agent_browser')).toMatchObject({
      id: 'vercel_agent_browser',
      origin: 'tooling-docs-derived',
    });
    expect(getOriginalSourceManifest('playwright')).toMatchObject({
      id: 'playwright',
      origin: 'npm-package-derived',
    });
  });

  it('keeps karpathy-loop snapshot provenance pinned to a concrete upstream commit', () => {
    const manifest = getOriginalSourceManifest('karpathy_loop');
    expect(manifest).not.toBeNull();
    expect(manifest?.notes || '').toContain(
      'https://github.com/karpathy/autoresearch',
    );
    expect(manifest?.notes || '').toContain(
      '228791fb499afffb54b46200aca536f79142f117',
    );

    const sourceNotesPath = path.resolve(
      process.cwd(),
      'original_source',
      'karpathy_loop',
      'source',
      'README.md',
    );
    expect(fs.existsSync(sourceNotesPath)).toBe(true);
    const sourceNotes = fs.readFileSync(sourceNotesPath, 'utf8');
    expect(sourceNotes).toContain('228791fb499afffb54b46200aca536f79142f117');

    const upstreamReadmePath = path.resolve(
      process.cwd(),
      'original_source',
      'karpathy_loop',
      'source',
      'upstream',
      '228791fb499afffb54b46200aca536f79142f117',
      'README.md',
    );
    expect(fs.existsSync(upstreamReadmePath)).toBe(true);
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

  it('resolves all debate mode source module references against preserved source manifests', () => {
    for (const mode of listDebateModeSpecs()) {
      for (const sourceModuleId of mode.sourceModuleIds || []) {
        expect(
          hasOriginalSourceManifest(sourceModuleId),
          `Missing preserved source manifest for debate mode ${mode.id} -> ${sourceModuleId}`,
        ).toBe(true);
      }
    }
  });

  it('resolves all debate protocol source module references against preserved source manifests', () => {
    for (const protocol of listDebateProtocolSpecs()) {
      for (const sourceModuleId of protocol.sourceModuleIds || []) {
        expect(
          hasOriginalSourceManifest(sourceModuleId),
          `Missing preserved source manifest for debate protocol ${protocol.id} -> ${sourceModuleId}`,
        ).toBe(true);
      }
    }
  });

});
