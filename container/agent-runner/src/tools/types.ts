/**
 * Shared types for NanoClaw browser/search tools.
 */

export interface BrowseSnapshot {
  url: string;
  title: string;
  /** Accessibility tree with interactive element refs (@e1, @e2, ...) */
  elements: string;
}

export interface BrowseResult {
  ok: boolean;
  snapshot?: BrowseSnapshot;
  screenshot?: string; // base64
  text?: string;
  error?: string;
}

export interface ToolContext {
  log: (message: string) => void;
  env: Record<string, string | undefined>;
}
