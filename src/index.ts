import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getDatabase,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { createWorkflowRepository } from './storage/workflows.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  resolveGroupTargetSender,
  shouldEnforceSingleSender,
} from './services/index.js';
import {
  buildDiscordCurrentAffairsSafetyBlock,
  buildDiscordSharedContextBlock,
  getDiscordGroupBindingForBotLabel,
  getDiscordGroupBindingForGroup,
  recordDiscordSharedVisibleReply,
} from './services/discord/index.js';
import { formatAgentFailureNotice } from './agent-failure.js';
import { normalizeAgentOutputs } from './agent-output.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { enforceContainerOnlyRuntime } from './runtime-mode.js';
import { WorkflowEngine } from './workflows/engine.js';
import { WorkflowStepContext } from './workflows/types.js';
import { SCHEDULER_POLL_INTERVAL } from './config.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

// Workflow engine instance (initialized after queue is ready)
let workflowEngine: WorkflowEngine | null = null;

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function parseDiscordBotLabelFromJid(jid: string): string | null {
  if (!jid.startsWith('dc:')) return null;
  const parts = jid.replace(/^dc:/, '').split(':');
  if (parts.length < 2) return 'primary';
  const label = parts[1]?.trim().toLowerCase();
  return label || null;
}

function migrateDiscordGroupRegistrations(): void {
  const existingEntries = Object.entries(registeredGroups);
  let normalizedCount = 0;
  let createdCount = 0;

  for (const [jid, group] of existingEntries) {
    const bindingByFolder = getDiscordGroupBindingForGroup(group.folder);
    if (!bindingByFolder) continue;
    const botLabel = parseDiscordBotLabelFromJid(jid);
    const bindingByLabel = botLabel
      ? getDiscordGroupBindingForBotLabel(botLabel)
      : null;
    const binding =
      bindingByLabel &&
      bindingByLabel.departmentId === bindingByFolder.departmentId
        ? bindingByLabel
        : bindingByFolder;

    const canonicalFolder = binding.canonicalGroupFolder;
    const requiresTrigger =
      binding.requiresTrigger === undefined
        ? group.requiresTrigger
        : binding.requiresTrigger;
    const needsUpdate =
      canonicalFolder !== group.folder ||
      requiresTrigger !== group.requiresTrigger;

    if (!needsUpdate) continue;

    const normalized: RegisteredGroup = {
      ...group,
      folder: canonicalFolder,
      requiresTrigger,
    };
    registerGroup(jid, normalized);
    normalizedCount += 1;

    const previousSession = sessions[group.folder];
    if (previousSession && !sessions[canonicalFolder]) {
      sessions[canonicalFolder] = previousSession;
      setSession(canonicalFolder, previousSession);
    }
  }

  const kimiBinding = getDiscordGroupBindingForBotLabel('kimi');
  if (kimiBinding) {
    for (const [jid, group] of Object.entries(registeredGroups)) {
      if (parseDiscordBotLabelFromJid(jid) !== 'workshop') continue;
      const channelId = jid.replace(/^dc:/, '').split(':')[0];
      const kimiJid = `dc:${channelId}:kimi`;
      if (registeredGroups[kimiJid]) continue;

      registerGroup(kimiJid, {
        name: `${group.name}-키미`,
        folder: kimiBinding.canonicalGroupFolder,
        trigger: '@키미',
        added_at: new Date().toISOString(),
        containerConfig: group.containerConfig,
        requiresTrigger:
          kimiBinding.requiresTrigger === undefined
            ? group.requiresTrigger
            : kimiBinding.requiresTrigger,
      });
      createdCount += 1;
    }
  }

  if (normalizedCount > 0 || createdCount > 0) {
    logger.info(
      { normalizedCount, createdCount },
      'Discord group registrations migrated to canonical bot folders',
    );
  }
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  // Merge config.json from group folder into containerConfig (file-based overrides)
  const groupConfigFile = path.join(groupDir, 'config.json');
  if (fs.existsSync(groupConfigFile)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(groupConfigFile, 'utf-8'));
      group = {
        ...group,
        containerConfig: { ...group.containerConfig, ...fileConfig },
      };
    } catch (err) {
      logger.warn(
        { folder: group.folder, err },
        'Failed to parse group config.json',
      );
    }
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'runs'), { recursive: true });

  // Copy AGENTS.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'AGENTS.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateDir = path.join(GROUPS_DIR, group.isMain ? 'main' : 'global');
    const templateFile = fs.existsSync(path.join(templateDir, 'AGENTS.md'))
      ? path.join(templateDir, 'AGENTS.md')
      : null;
    if (templateFile) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created AGENTS.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const promptBase = formatMessages(missedMessages, TIMEZONE);
  const currentAffairsSafetyBlock = buildDiscordCurrentAffairsSafetyBlock(
    group,
    missedMessages,
  );
  const sharedContextBlock = buildDiscordSharedContextBlock(group, chatJid, {
    beforeTimestamp: missedMessages[0]?.timestamp,
    limit: 30,
  });
  const prompt = [currentAffairsSafetyBlock, sharedContextBlock, promptBase]
    .filter(Boolean)
    .join('\n\n');

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let agentErrorMessage: string | null = null;
  let failureNoticeSent = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      const targetSender = resolveGroupTargetSender(group, chatJid);
      const outputs = normalizeAgentOutputs(raw, group, targetSender, {
        enforceSingleSender: shouldEnforceSingleSender(group),
      });
      for (const output of outputs) {
        await channel.sendMessage(chatJid, output.text, {
          sender: output.sender,
        });
        recordDiscordSharedVisibleReply(
          group,
          chatJid,
          output.sender,
          output.text,
        );
      }
      if (outputs.length > 0) {
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
      agentErrorMessage = result.error || agentErrorMessage;
      if (!failureNoticeSent) {
        const sender = resolveGroupTargetSender(group, chatJid);
        const notice = formatAgentFailureNotice(agentErrorMessage);
        await channel.sendMessage(chatJid, notice, { sender });
        recordDiscordSharedVisibleReply(group, chatJid, sender, notice);
        outputSentToUser = true;
        failureNoticeSent = true;
      }
      queue.closeStdin(chatJid);
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }

    if (!failureNoticeSent) {
      try {
        const sender = resolveGroupTargetSender(group, chatJid);
        const notice = formatAgentFailureNotice(agentErrorMessage);
        await channel.sendMessage(chatJid, notice, { sender });
        recordDiscordSharedVisibleReply(group, chatJid, sender, notice);
        logger.warn(
          { group: group.name, error: agentErrorMessage },
          'Agent error without user output, sent failure notice',
        );
        return true;
      } catch (err) {
        logger.error(
          { group: group.name, err },
          'Failed to send agent failure notice',
        );
      }
    }

    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);
          const currentAffairsSafetyBlock =
            buildDiscordCurrentAffairsSafetyBlock(group, messagesToSend);
          const pipedPrompt = [currentAffairsSafetyBlock, formatted]
            .filter(Boolean)
            .join('\n\n');

          if (queue.sendMessage(chatJid, pipedPrompt)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  enforceContainerOnlyRuntime();
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  migrateDiscordGroupRegistrations();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text, opts) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text, opts).then(() => {
        const group = registeredGroups[jid];
        if (group && opts?.sender) {
          recordDiscordSharedVisibleReply(group, jid, opts.sender, text);
        }
      });
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    onWorkflowRequested: (title, steps, flowId, sourceGroup, chatJid) => {
      if (workflowEngine) {
        workflowEngine
          .requestWorkflow(title, steps, sourceGroup, chatJid, flowId, {
            autoStart: true,
          })
          .catch(async (err) => {
            logger.error({ err, title }, 'Failed to create workflow');
            if (!chatJid) return;
            const reason = err instanceof Error ? err.message : String(err);
            const channel = findChannel(channels, chatJid);
            if (!channel) {
              logger.warn(
                { chatJid, title },
                'Cannot send workflow failure message: channel not found',
              );
              return;
            }
            try {
              await channel.sendMessage(
                chatJid,
                `워크플로우 시작 실패: ${reason}`,
              );
            } catch (sendErr) {
              logger.error(
                { err: sendErr, chatJid, title },
                'Failed to send workflow failure message',
              );
            }
          });
      }
    },
    onWorkflowStepResult: (workflowId, stepIndex, status, resultSummary) => {
      if (workflowEngine) {
        const handler =
          status === 'completed'
            ? workflowEngine.onStepCompleted(
                workflowId,
                stepIndex,
                resultSummary,
              )
            : workflowEngine.onStepFailed(workflowId, stepIndex, resultSummary);
        handler.catch((err) =>
          logger.error(
            { err, workflowId, stepIndex },
            'Failed to process step result',
          ),
        );
      }
    },
    onWorkflowCancelled: (workflowId, sourceGroup) => {
      if (workflowEngine) {
        workflowEngine
          .cancelWorkflow(workflowId, sourceGroup)
          .catch((err) =>
            logger.error({ err, workflowId }, 'Failed to cancel workflow'),
          );
      }
    },
  });

  // Initialize workflow engine
  workflowEngine = new WorkflowEngine({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (channel) await channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    repository: createWorkflowRepository(getDatabase()),
    enqueueWorkflowStep: (
      groupJid: string,
      stepId: string,
      prompt: string,
      _context: WorkflowStepContext,
    ) => {
      queue.enqueueTask(groupJid, `wf-step-${stepId}`, async () => {
        // The workflow step runs as a regular container task
        // The prompt includes workflow context and instructions to call report_result
        const group = registeredGroups[groupJid];
        if (!group) {
          logger.error(
            { groupJid, stepId },
            'Workflow step target group not found',
          );
          return;
        }
        // Enqueue message check to process the workflow step prompt
        queue.sendMessage(groupJid, prompt);
      });
    },
    closeStdin: (groupJid: string) => {
      queue.closeStdin(groupJid);
    },
    executeQualityLoop: async (params, onProgress) => {
      const enginePath = path.resolve(
        __dirname,
        '..',
        'src',
        'catalog',
        'methods',
        'karpathy-loop',
        'engine.py',
      );
      const pythonBin =
        process.env.QUALITY_LOOP_PYTHON ||
        path.resolve(__dirname, '..', '.venv', 'bin', 'python');

      const args = [
        enginePath,
        '--task',
        params.task,
        '--rubric',
        params.rubricPath,
        '--output',
        params.outputDir,
      ];
      for (const f of params.inputFiles) {
        args.push('--input', f);
      }
      for (const f of params.referenceFiles) {
        args.push('--reference', f);
      }
      if (params.model) {
        args.push('--model', params.model);
      }

      fs.mkdirSync(params.outputDir, { recursive: true });

      return new Promise((resolve, reject) => {
        const proc = spawn(pythonBin, args, {
          cwd: path.resolve(__dirname, '..'),
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderr = '';
        proc.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          stderr += text;
          for (const line of text.split('\n')) {
            if (line.includes('PROGRESS')) {
              onProgress(line.replace(/.*PROGRESS\s*/, '').trim());
            }
          }
        });

        proc.on('close', (code) => {
          const reportPath = path.join(params.outputDir, 'report.json');
          try {
            const raw = fs.readFileSync(reportPath, 'utf-8');
            const report = JSON.parse(raw);
            resolve({
              status: report.status,
              finalScore: report.final_score ?? null,
              outputFiles: report.output_files || [],
              runId: report.run_id,
              error: report.error,
              history: (report.history || []).map(
                (h: { iteration: number; total: number; verdict: string }) => ({
                  iteration: h.iteration,
                  total: h.total,
                  verdict: h.verdict,
                }),
              ),
            });
          } catch {
            reject(
              new Error(
                `Quality loop failed (exit ${code}): ${stderr.slice(-500)}`,
              ),
            );
          }
        });

        proc.on('error', (err) => {
          reject(
            new Error(`Failed to spawn quality loop process: ${err.message}`),
          );
        });
      });
    },
  });

  // Recover workflows on restart
  workflowEngine
    .recoverOnRestart()
    .catch((err) =>
      logger.error({ err }, 'Failed to recover workflows on restart'),
    );

  // Periodic lease expiry check
  setInterval(() => {
    if (workflowEngine) {
      workflowEngine
        .checkExpiredLeases()
        .catch((err) =>
          logger.error({ err }, 'Failed to check expired leases'),
        );
      workflowEngine
        .drainPendingSteps()
        .catch((err) =>
          logger.error({ err }, 'Failed to drain pending workflow steps'),
        );
    }
  }, SCHEDULER_POLL_INTERVAL);

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
