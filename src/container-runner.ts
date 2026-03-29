/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { getAgentBackendConfig } from './agent-backend.js';
import { readEnvFile } from './env.js';
import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { OneCLI } from '@onecli-sh/sdk';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup, SubAgentConfig } from './types.js';
import { buildGroupAgentTeam } from './agents/index.js';
import { resolveServiceDeployment } from './services/index.js';

const onecli = new OneCLI({ url: ONECLI_URL });

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  instructionLayers?: Array<{
    id: string;
    content: string;
  }>;
  /** Resolved sub-agent configs for ask_agent MCP tool. */
  subAgents?: Array<{
    name: string;
    backend: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    role?: string;
    allowedTools?: string[];
  }>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildServiceInstructionLayers(
  group: RegisteredGroup,
): Array<{ id: string; content: string }> {
  const deployment = resolveServiceDeployment(group);
  if (!deployment) return [];

  const layers: Array<{ id: string; content: string }> = [];
  if (deployment.leadCapabilityPrompt) {
    layers.push({
      id: `catalog-capability:${deployment.lead?.id || deployment.id}`,
      content: deployment.leadCapabilityPrompt,
    });
  }
  if (deployment.leadPrompt) {
    layers.push({
      id: `service-personnel:${deployment.lead?.id || deployment.id}`,
      content: deployment.leadPrompt,
    });
  }
  if (deployment.departmentPrompt) {
    layers.push({
      id: `service-department:${deployment.departmentId}`,
      content: deployment.departmentPrompt,
    });
  }
  const rosterLines = [
    `Service: ${deployment.service}`,
    `Department: ${deployment.department.displayName} (${deployment.department.id})`,
    deployment.lead
      ? `Lead: ${deployment.lead.displayName} — ${deployment.lead.role || 'unspecified role'}`
      : null,
    ...deployment.teammates.map(
      (teammate) =>
        `Teammate: ${teammate.displayName} — ${teammate.role || 'unspecified role'}`,
    ),
  ].filter((line): line is string => Boolean(line));
  if (rosterLines.length > 0) {
    layers.push({
      id: `service-roster:${deployment.id}`,
      content: ['## Service Roster', '', ...rosterLines].join('\n'),
    });
  }
  return layers;
}

function listRelativeFilesRecursive(
  rootDir: string,
  currentDir = rootDir,
): string[] {
  const entries = fs.readdirSync(currentDir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...listRelativeFilesRecursive(rootDir, fullPath));
      continue;
    }
    files.push(path.relative(rootDir, fullPath));
  }

  return files.sort();
}

function needsAgentRunnerRefresh(
  sourceDir: string,
  cachedDir: string,
): boolean {
  if (!fs.existsSync(cachedDir)) return true;

  const sourceFiles = listRelativeFilesRecursive(sourceDir);
  const cachedFiles = listRelativeFilesRecursive(cachedDir);

  if (sourceFiles.length !== cachedFiles.length) return true;
  const sourceSet = new Set(sourceFiles);
  if (cachedFiles.some((file) => !sourceSet.has(file))) return true;

  for (const relativePath of sourceFiles) {
    const sourcePath = path.join(sourceDir, relativePath);
    const cachedPath = path.join(cachedDir, relativePath);
    if (!fs.existsSync(cachedPath)) return true;
    if (fs.statSync(sourcePath).mtimeMs > fs.statSync(cachedPath).mtimeMs) {
      return true;
    }
  }

  return false;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the OneCLI gateway, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({}, null, 2) + '\n');
  }

  // Sync shared container skills into Claude's compatibility path.
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const claudeSkillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(claudeSkillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group .nanoclaw directory for non-Claude backends (e.g. OpenCode session state)
  const groupNanoClawDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.nanoclaw',
  );
  fs.mkdirSync(groupNanoClawDir, { recursive: true });
  // Sync the same shared skills into a provider-agnostic runtime path.
  const sharedSkillsDst = path.join(groupNanoClawDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(sharedSkillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupNanoClawDir,
    containerPath: '/home/node/.nanoclaw',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    if (needsAgentRunnerRefresh(agentRunnerSrc, groupAgentRunnerDir)) {
      fs.rmSync(groupAgentRunnerDir, { recursive: true, force: true });
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Resolve sub-agent credentials using global config as fallback.
 * Returns entries ready to be passed to the container via ContainerInput.
 */
export function resolveSubAgentCredentials(subAgents: SubAgentConfig[]): Array<{
  name: string;
  backend: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  role?: string;
  systemPrompt?: string;
  allowedTools?: string[];
}> {
  const globalConfig = getAgentBackendConfig();
  return subAgents.map((sa) => {
    let apiKey = sa.apiKey;
    let baseUrl = sa.baseUrl;
    let model = sa.model;

    // Resolve fallback credentials per backend
    switch (sa.backend) {
      case 'opencode':
        if (!apiKey) apiKey = globalConfig.opencodeApiKey;
        if (!model) model = globalConfig.opencodeModel;
        break;
      case 'zai':
      case 'openai-compat':
        if (!apiKey) apiKey = globalConfig.openaiCompatApiKey;
        if (!baseUrl) baseUrl = globalConfig.openaiCompatBaseUrl;
        if (!model) model = globalConfig.openaiCompatModel;
        break;
      case 'openai':
        if (!apiKey) apiKey = globalConfig.openaiApiKey;
        if (!baseUrl) baseUrl = globalConfig.openaiBaseUrl;
        if (!model) model = globalConfig.openaiModel;
        break;
    }

    return {
      name: sa.name,
      backend: sa.backend,
      model,
      apiKey,
      baseUrl,
      role: sa.role,
      systemPrompt: sa.systemPrompt,
      allowedTools: sa.allowedTools,
    };
  });
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentIdentifier?: string,
  group?: RegisteredGroup,
): Promise<string[]> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];
  const globalConfig = getAgentBackendConfig();

  // Per-group backend override from containerConfig, fallback to global
  const deployment = group ? resolveServiceDeployment(group) : null;
  const runtimeCfg = deployment?.containerRuntime;
  const lead = deployment?.lead;
  const groupCfg = group?.containerConfig;
  const backend = groupCfg?.backend || lead?.backend || globalConfig.backend;

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Tell the container which agent backend to use
  args.push('-e', `NANOCLAW_AGENT_BACKEND=${backend}`);

  // Pass allowed tools list for per-group tool filtering
  const leadAllowedTools =
    runtimeCfg?.allowedTools && runtimeCfg.allowedTools.length > 0
      ? runtimeCfg.allowedTools
      : groupCfg?.allowedTools;
  if (leadAllowedTools && leadAllowedTools.length > 0) {
    args.push('-e', `NANOCLAW_ALLOWED_TOOLS=${leadAllowedTools.join(',')}`);
  }
  if (runtimeCfg?.browserPolicy) {
    args.push(
      '-e',
      `NANOCLAW_BROWSER_POLICY=${JSON.stringify(runtimeCfg.browserPolicy)}`,
    );
  }

  // Optional Cloudflare Browser Rendering credentials for cloudflare_fetch tool
  const cfEnv = readEnvFile(['CF_ACCOUNT_ID', 'CF_API_TOKEN']);
  const cfAccountId = process.env.CF_ACCOUNT_ID || cfEnv.CF_ACCOUNT_ID;
  const cfApiToken = process.env.CF_API_TOKEN || cfEnv.CF_API_TOKEN;
  if (cfAccountId) args.push('-e', `CF_ACCOUNT_ID=${cfAccountId}`);
  if (cfApiToken) args.push('-e', `CF_API_TOKEN=${cfApiToken}`);

  if (backend === 'claude') {
    // OneCLI gateway handles credential injection — containers never see real secrets.
    const onecliApplied = await onecli.applyContainerConfig(args, {
      addHostMapping: false,
      agent: agentIdentifier,
    });
    if (onecliApplied) {
      logger.info({ containerName }, 'OneCLI gateway config applied');
    } else {
      logger.warn(
        { containerName },
        'OneCLI gateway not reachable — container will have no credentials',
      );
    }
  } else if (backend === 'opencode') {
    const apiKey = groupCfg?.apiKey || globalConfig.opencodeApiKey;
    const model = groupCfg?.model || lead?.model || globalConfig.opencodeModel;
    if (apiKey) args.push('-e', `OPENCODE_API_KEY=${apiKey}`);
    if (model) args.push('-e', `OPENCODE_MODEL=${model}`);
    // Also pass OpenAI credentials for ask_codex tool (dual-model collaboration)
    const openaiKey = globalConfig.openaiApiKey;
    const openaiModel = process.env.CODEX_MODEL || 'gpt-5.4-codex';
    if (openaiKey) args.push('-e', `OPENAI_API_KEY=${openaiKey}`);
    args.push('-e', `CODEX_MODEL=${openaiModel}`);
  } else if (backend === 'openai-compat' || backend === 'zai') {
    const apiKey = groupCfg?.apiKey || globalConfig.openaiCompatApiKey;
    const baseUrl =
      groupCfg?.baseUrl || lead?.baseUrl || globalConfig.openaiCompatBaseUrl;
    const model =
      groupCfg?.model || lead?.model || globalConfig.openaiCompatModel;
    if (apiKey) args.push('-e', `OPENAI_COMPAT_API_KEY=${apiKey}`);
    if (baseUrl) args.push('-e', `OPENAI_COMPAT_BASE_URL=${baseUrl}`);
    if (model) args.push('-e', `OPENAI_COMPAT_MODEL=${model}`);
  } else if (backend === 'openai') {
    const apiKey = groupCfg?.apiKey || globalConfig.openaiApiKey;
    const baseUrl =
      groupCfg?.baseUrl || lead?.baseUrl || globalConfig.openaiBaseUrl;
    const model = groupCfg?.model || lead?.model || globalConfig.openaiModel;
    if (apiKey) args.push('-e', `OPENAI_API_KEY=${apiKey}`);
    if (baseUrl) args.push('-e', `OPENAI_BASE_URL=${baseUrl}`);
    if (model) args.push('-e', `OPENAI_MODEL=${model}`);
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  // Main group uses the default OneCLI agent; others use their own agent.
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');
  const containerArgs = await buildContainerArgs(
    mounts,
    containerName,
    agentIdentifier,
    group,
  );

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Resolve sub-agent credentials and include in container input
    const containerInput = { ...input };
    const instructionLayers = buildServiceInstructionLayers(group);
    if (instructionLayers.length > 0) {
      containerInput.instructionLayers = instructionLayers;
      logger.info(
        {
          group: group.name,
          layerIds: instructionLayers.map((layer) => layer.id),
        },
        'Passing resolved instruction layers to container',
      );
    }
    const groupTeam = buildGroupAgentTeam(group);
    if (groupTeam.teammateConfigs.length > 0) {
      containerInput.subAgents = resolveSubAgentCredentials(
        groupTeam.teammateConfigs,
      );
      logger.info(
        { group: group!.name, count: groupTeam.teammateConfigs.length },
        'Passing sub-agents to container',
      );
    }

    container.stdin.write(JSON.stringify(containerInput));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
