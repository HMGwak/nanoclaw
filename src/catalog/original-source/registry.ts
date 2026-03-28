import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OriginalSourceManifest } from './types.js';

const ORIGINAL_SOURCE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../original_source',
);

function readManifest(moduleDir: string): OriginalSourceManifest | null {
  const manifestPath = path.join(moduleDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  const raw = fs.readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw) as OriginalSourceManifest;
}

export function listOriginalSourceManifests(): OriginalSourceManifest[] {
  if (!fs.existsSync(ORIGINAL_SOURCE_DIR)) return [];

  return fs
    .readdirSync(ORIGINAL_SOURCE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readManifest(path.join(ORIGINAL_SOURCE_DIR, entry.name)))
    .filter((manifest): manifest is OriginalSourceManifest => manifest !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getOriginalSourceManifest(
  id: string,
): OriginalSourceManifest | null {
  return (
    listOriginalSourceManifests().find((manifest) => manifest.id === id) || null
  );
}

export function hasOriginalSourceManifest(id: string): boolean {
  return getOriginalSourceManifest(id) !== null;
}
