import { describe, expect, it } from 'vitest';

import {
  buildAgentBrowserToolSource,
  buildPlaywrightToolSource,
  runCommandWithClosedStdin,
} from './opencode.js';

describe('OpenCode custom tool source generation', () => {
  it('uses the current OpenCode plugin import for browser tools', () => {
    const source = buildAgentBrowserToolSource();

    expect(source).toContain('import { tool } from "@opencode-ai/plugin";');
    expect(source).not.toContain('opencode/tool');
    expect(source).toContain('tool.schema.string()');
  });

  it('keeps Playwright tool coverage aligned with the shared catalog', () => {
    const source = buildPlaywrightToolSource();

    expect(source).toContain('import { tool } from "@opencode-ai/plugin";');
    expect(source).toContain('export const pdf = tool({');
    expect(source).toContain('selectors: tool.schema.string().describe(');
    expect(source).toContain('JSON.parse(args.selectors)');
  });

  it('closes child stdin so CLI commands waiting on EOF can exit', async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );

    const result = await runCommandWithClosedStdin(
      process.execPath,
      [
        '-e',
        [
          "process.stdin.setEncoding('utf8');",
          "process.stdin.resume();",
          "process.stdin.on('end', () => {",
          "  process.stdout.write('stdin-closed\\n');",
          '  process.exit(0);',
          '});',
          "setTimeout(() => process.exit(9), 200);",
        ].join(''),
      ],
      {
        cwd: process.cwd(),
        env,
        timeoutMs: 2000,
        maxBuffer: 4096,
        log: () => {},
      },
    );

    expect(result.stdout.trim()).toBe('stdin-closed');
    expect(result.stderr).toBe('');
  });
});
