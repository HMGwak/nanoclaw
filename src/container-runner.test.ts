import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const { validateAdditionalMountsMock } = vi.hoisted(() => ({
  validateAdditionalMountsMock: vi.fn<
    (...args: unknown[]) => Array<{
      hostPath: string;
      containerPath: string;
      readonly: boolean;
    }>
  >(() => []),
}));

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  ONECLI_URL: 'http://localhost:10254',
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((filepath: string) => {
        return (
          filepath.includes('/src/services/discord/resources/prompts/') ||
          filepath.includes('/src/services/discord/departments/')
        );
      }),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn((filepath: string) => {
        if (filepath.includes('workshop-teamlead.md')) {
          return 'lead persona prompt';
        }
        if (filepath.includes('workshop-kimi.md')) {
          return 'kimi persona prompt';
        }
        if (filepath.includes('planning-lead.md')) {
          return 'planning persona prompt';
        }
        if (filepath.includes('/departments/workshop/AGENTS.md')) {
          return 'workshop department prompt';
        }
        if (filepath.includes('/departments/planning/AGENTS.md')) {
          return 'planning department prompt';
        }
        if (filepath.includes('/departments/handoff/template.md')) {
          return 'handoff template';
        }
        return '';
      }),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: validateAdditionalMountsMock,
}));

// Mock OneCLI SDK
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    createAgent = vi.fn().mockResolvedValue({ id: 'test' });
    ensureAgent = vi
      .fn()
      .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  runContainerAgent,
  ContainerOutput,
  resolveSubAgentCredentials,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
    validateAdditionalMountsMock.mockReset();
    validateAdditionalMountsMock.mockReturnValue([]);
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('resolveSubAgentCredentials', () => {
  it('preserves per-agent allowedTools when passing sub-agents to the container', () => {
    const resolved = resolveSubAgentCredentials([
      {
        name: '키미',
        backend: 'opencode',
        model: 'opencode-go/kimi-k2.5',
        systemPrompt: 'persona + department',
        allowedTools: ['web_search', 'browse_open'],
      },
    ]);

    expect(resolved).toEqual([
      expect.objectContaining({
        name: '키미',
        backend: 'opencode',
        model: 'opencode-go/kimi-k2.5',
        systemPrompt: 'persona + department',
        allowedTools: ['web_search', 'browse_open'],
      }),
    ]);
  });
});

describe('container instruction layers', () => {
  it('passes service-owned instruction layers into the container input', async () => {
    let stdinData = '';
    fakeProc = createFakeProcess();
    fakeProc.stdin.on('data', (chunk) => {
      stdinData += chunk.toString();
    });

    const resultPromise = runContainerAgent(
      {
        ...testGroup,
        folder: 'discord_workshop',
        name: '작업실',
      },
      {
        ...testInput,
        groupFolder: 'discord_workshop',
      },
      () => {},
      async () => {},
    );
    await new Promise<void>((resolve) => fakeProc.stdin.on('finish', resolve));

    const containerInput = JSON.parse(stdinData);
    expect(containerInput.instructionLayers).toEqual([
      {
        id: 'catalog-capability:discord_workshop_teamlead',
        content: expect.stringContaining('operating as a planner'),
      },
      {
        id: 'service-personnel:discord_workshop_teamlead',
        content: 'lead persona prompt',
      },
      {
        id: 'service-department:workshop',
        content: 'workshop department prompt',
      },
      {
        id: 'service-roster:discord-workshop-teamlead',
        content: expect.stringContaining('Lead: 작업실 팀장'),
      },
    ]);
    expect(containerInput.instructionLayers[3].content).toContain(
      'Teammate: 키미',
    );
    expect(containerInput.subAgents).toEqual([
      expect.objectContaining({
        name: '키미',
        systemPrompt: expect.stringContaining('workshop department prompt'),
      }),
    ]);

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    fakeProc.emit('close', 0);
    await resultPromise;
  });

  it('adds a debate intent layer for planning when the prompt contains debate keywords', async () => {
    let stdinData = '';
    fakeProc = createFakeProcess();
    fakeProc.stdin.on('data', (chunk) => {
      stdinData += chunk.toString();
    });

    const resultPromise = runContainerAgent(
      {
        ...testGroup,
        folder: 'discord_planning',
        name: '기획실',
      },
      {
        ...testInput,
        prompt: '이 구조로 토론해봐',
        groupFolder: 'discord_planning',
      },
      () => {},
      async () => {},
    );
    await new Promise<void>((resolve) => fakeProc.stdin.on('finish', resolve));

    const containerInput = JSON.parse(stdinData);
    expect(containerInput.instructionLayers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'service-debate-intent:discord-planning-bot',
          content: expect.stringContaining('Debate keyword detected'),
        }),
      ]),
    );
    const debateLayer = containerInput.instructionLayers.find(
      (layer: { id: string; content: string }) =>
        layer.id === 'service-debate-intent:discord-planning-bot',
    );
    expect(debateLayer?.content).toContain(
      'Treat this as an explicit trigger to call `run_debate`',
    );
    expect(debateLayer?.content).toContain(
      'Before calling `run_debate`, gather objective evidence',
    );
    expect(debateLayer?.content).toContain(
      'Pass that evidence through `evidence_packs`',
    );
    expect(debateLayer?.content).toContain('Mode hint: standard');
    expect(debateLayer?.content).toContain('Topic: 이 구조로 토론해봐');

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    fakeProc.emit('close', 0);
    await resultPromise;
  });

  it('passes browser policy env from service deployment into container args', async () => {
    fakeProc = createFakeProcess();
    const spawnMock = vi.mocked(spawn);

    const resultPromise = runContainerAgent(
      {
        ...testGroup,
        folder: 'discord_workshop',
        name: '작업실',
      },
      {
        ...testInput,
        groupFolder: 'discord_workshop',
      },
      () => {},
      async () => {},
    );

    await new Promise<void>((resolve) => fakeProc.stdin.on('finish', resolve));

    const lastSpawnCall = spawnMock.mock.calls.at(-1);
    expect(lastSpawnCall).toBeDefined();
    const args = (lastSpawnCall?.[1] || []) as string[];
    const policyArg = args.find((arg) =>
      arg.startsWith('NANOCLAW_BROWSER_POLICY='),
    );
    expect(policyArg).toBeDefined();
    expect(policyArg).toContain('"enforcement":"hard"');
    expect(policyArg).toContain(
      '"chain":["cloudflare_fetch","agent_browser","playwright"]',
    );

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    fakeProc.emit('close', 0);
    await resultPromise;
  });

  it('passes secretary skill ids and validated mounted directories into the container input', async () => {
    let stdinData = '';
    fakeProc = createFakeProcess();
    fakeProc.stdin.on('data', (chunk) => {
      stdinData += chunk.toString();
    });
    validateAdditionalMountsMock.mockReturnValueOnce([
      {
        hostPath: '/Users/planee/Documents/Mywork',
        containerPath: '/workspace/extra/obsidian-vault',
        readonly: true,
      },
    ]);

    const resultPromise = runContainerAgent(
      {
        ...testGroup,
        folder: 'discord_secretary',
        name: '비서실',
      },
      {
        ...testInput,
        groupFolder: 'discord_secretary',
      },
      () => {},
      async () => {},
    );
    await new Promise<void>((resolve) => fakeProc.stdin.on('finish', resolve));

    const containerInput = JSON.parse(stdinData);
    expect(containerInput.skillIds).toEqual(
      expect.arrayContaining(['agent-browser', 'obsidian-markdown']),
    );
    expect(containerInput.mountedDirectories).toEqual([
      {
        path: '/workspace/extra/obsidian-vault',
        readonly: true,
      },
    ]);

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    fakeProc.emit('close', 0);
    await resultPromise;
  });
});
