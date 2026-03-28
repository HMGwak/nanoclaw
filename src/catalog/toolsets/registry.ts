import { ToolsetSpec } from './types.js';

const TOOLSETS: Record<string, ToolsetSpec> = {
  'workshop-teamleader-default': {
    id: 'workshop-teamleader-default',
    description: 'Default unrestricted toolset for the workshop team leader.',
    allowedTools: null,
    skillIds: ['agent-browser'],
  },
  'workshop-teammate-kimi-research': {
    id: 'workshop-teammate-kimi-research',
    description:
      'Browser-first research toolset for Kimi inside the workshop team.',
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
  'planning-default': {
    id: 'planning-default',
    description: 'Planning lead toolset.',
    allowedTools: null,
    skillIds: ['agent-browser'],
  },
  'secretary-default': {
    id: 'secretary-default',
    description: 'Secretary lead toolset.',
    allowedTools: null,
  },
};

export function getToolsetSpec(id: string): ToolsetSpec | null {
  return TOOLSETS[id] || null;
}

export function listToolsetSpecs(): ToolsetSpec[] {
  return Object.values(TOOLSETS);
}
