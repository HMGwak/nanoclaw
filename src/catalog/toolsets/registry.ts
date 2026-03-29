import { ToolsetSpec } from './types.js';

const TOOLSETS: Record<string, ToolsetSpec> = {
  global_general_cli: {
    id: 'global_general_cli',
    description: 'General-purpose global toolset for planning and execution.',
    allowedTools: null,
    skillIds: ['agent-browser'],
  },
  global_browser_research: {
    id: 'global_browser_research',
    description: 'Browser-first global research toolset.',
    allowedTools: [
      'web_search',
      'web_fetch',
      'browse_open',
      'browse_click',
      'browse_fill',
      'browse_select',
      'browse_snapshot',
      'browse_screenshot',
      'browse_get_text',
      'browse_press',
      'browse_close',
      'playwright_open',
      'playwright_screenshot',
      'playwright_execute',
      'playwright_extract',
      'playwright_pdf',
    ],
    skillIds: ['agent-browser'],
    sourceModuleIds: ['autoresearch'],
  },
};

export function getToolsetSpec(id: string): ToolsetSpec | null {
  return TOOLSETS[id] || null;
}

export function listToolsetSpecs(): ToolsetSpec[] {
  return Object.values(TOOLSETS);
}
