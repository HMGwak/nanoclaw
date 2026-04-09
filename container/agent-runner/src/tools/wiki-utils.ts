/**
 * Wiki-related utility functions shared between shared.ts and ipc-mcp-stdio.ts.
 * Extracted to eliminate duplication of vault path normalization and file discovery logic.
 */

import fs from 'fs';
import path from 'path';

export const CONTAINER_VAULT_PREFIXES = [
  '/workspace/extra/vault',
  '/workspace/extra/obsidian-vault',
];

/**
 * Detect container vault prefix in rawVaultRoot and return the host path instead.
 * If rawVaultRoot is already a host path, returns it unchanged.
 */
export function normalizeVaultRoot(rawVaultRoot: string, defaultHostPath: string): string {
  return CONTAINER_VAULT_PREFIXES.some((p) => rawVaultRoot.startsWith(p))
    ? defaultHostPath
    : rawVaultRoot;
}

/**
 * Convert a container-internal path to the corresponding host path.
 * Handles CONTAINER_VAULT_PREFIXES and /workspace/project/ prefixes.
 */
export function toHostPath(p: string, vaultRoot: string): string {
  for (const prefix of CONTAINER_VAULT_PREFIXES) {
    if (p.startsWith(prefix + '/')) {
      return path.join(vaultRoot, p.slice(prefix.length + 1));
    }
  }
  if (p.startsWith('/workspace/project/')) {
    return p.slice('/workspace/project/'.length);
  }
  return p;
}

/**
 * Unified file discovery by domain name across one or more directories.
 * Used for both rubric (.md) and base (.base) file discovery.
 *
 * Search strategy:
 *   1. Exact match: filename contains domain as-is AND ends with ext
 *   2. Normalized fuzzy match: whitespace-stripped filename contains whitespace-stripped domain
 *
 * NOTE: findBaseFile originally used only the fuzzy match step. Adding exact match
 * first is safe because .base files are named after their domain, so exact match
 * will find them when present and the fuzzy fallback still covers edge cases.
 */
export function findFileByDomain(dirs: string[], ext: string, domain: string): string {
  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir);
      // 1. Exact match — domain substring present, correct extension
      const exact = files.find((f) => f.includes(domain) && f.endsWith(ext));
      if (exact) return path.join(dir, exact);
      // 2. Normalized fuzzy match — strip whitespace
      const normalized = domain.replace(/\s+/g, '');
      const partial = files.find(
        (f) => f.replace(/\s+/g, '').includes(normalized) && f.endsWith(ext),
      );
      if (partial) return path.join(dir, partial);
    } catch {
      /* directory may not exist — ignore */
    }
  }
  return '';
}
