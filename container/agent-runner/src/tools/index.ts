/**
 * NanoClaw Browser Tools
 *
 * Two browser engines available:
 * - agent-browser (Vercel): Token-efficient, accessibility-tree snapshots, ref-based interaction
 * - Playwright: Full-control, screenshots, precise selectors, complex automation
 *
 * Use agent-browser for everyday browsing. Use Playwright for heavy automation.
 */

// Agent Browser (lightweight, token-efficient)
export {
  agentBrowseOpen,
  agentBrowseClick,
  agentBrowseFill,
  agentBrowseSelect,
  agentBrowseSnapshot,
  agentBrowseScreenshot,
  agentBrowseGetText,
  agentBrowsePress,
  agentBrowseClose,
} from './browse-agent.js';

// Playwright (full-control, heavy)
export {
  playwrightOpen,
  playwrightScreenshot,
  playwrightExecute,
  playwrightExtract,
  playwrightPdf,
} from './browse-playwright.js';

// Types
export type { BrowseResult, BrowseSnapshot, ToolContext } from './types.js';
