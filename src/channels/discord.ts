import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import {
  loadDiscordServiceBots,
  normalizeDiscordPersonaText,
  resolveDiscordPersonaBotLabel,
  resolveDiscordPersonaMode,
} from '../services/discord/index.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface BotClient {
  client: Client;
  token: string;
  label: string; // e.g. "비서실", "작업실"
  botUserId?: string;
}

interface DiscordWebhook {
  send: (opts: { content: string; username?: string }) => Promise<unknown>;
}

const BOT_LOGIN_TIMEOUT_MS = 30_000;

export class DiscordChannel implements Channel {
  name = 'discord';

  private bots: BotClient[] = [];
  private opts: DiscordChannelOpts;
  private primaryToken: string;
  private webhookCache = new Map<string, DiscordWebhook>();

  constructor(primaryToken: string, opts: DiscordChannelOpts) {
    this.primaryToken = primaryToken;
    this.opts = opts;
  }

  /**
   * Find the bot label for a given JID.
   * JID format: "dc:channelId" (primary) or "dc:channelId:botLabel" (secondary)
   */
  private getBotForJid(jid: string): BotClient | undefined {
    const parts = jid.replace(/^dc:/, '').split(':');
    if (parts.length >= 2) {
      // Secondary bot: dc:channelId:botLabel
      const botLabel = parts[1];
      return this.bots.find((b) => b.label === botLabel) || this.bots[0];
    }
    // Primary bot: dc:channelId
    return this.bots[0];
  }

  private getPersonaBotForSender(
    jid: string,
    sender?: string,
  ): BotClient | undefined {
    const group = this.opts.registeredGroups()[jid];
    const mappedLabel = resolveDiscordPersonaBotLabel(group, sender);
    if (!mappedLabel) return undefined;
    return this.bots.find((b) => b.label === mappedLabel);
  }

  private getPersonaMode(jid: string): 'hybrid' | 'bot_only' {
    const group = this.opts.registeredGroups()[jid];
    return resolveDiscordPersonaMode(group);
  }

  private setupMessageHandler(bot: BotClient, isPrimary: boolean): void {
    bot.client.on(Events.MessageCreate, async (message: Message) => {
      if (message.author.bot) return;

      const channelId = message.channelId;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Step 1: Check if THIS bot was @mentioned (user mention or managed role mention)
      const botId = bot.client.user?.id;
      let thisBotMentioned = false;
      if (botId) {
        thisBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`) ||
          message.mentions.roles.some((role) => role.tags?.botId === botId);
      }

      // Step 2: Check reply — if replying to THIS bot's message, treat as mention
      let replyContext = '';
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          if (botId && repliedTo.author.id === botId) {
            thisBotMentioned = true;
          }
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          replyContext = `[Reply to ${replyAuthor}]`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Step 3: Determine JID
      let chatJid: string;
      if (isPrimary) {
        chatJid = `dc:${channelId}`;
      } else {
        chatJid = `dc:${channelId}:${bot.label}`;
      }
      const registeredGroup = this.opts.registeredGroups()[chatJid];
      const requiresTrigger = registeredGroup?.requiresTrigger !== false;

      // Step 4: Secondary bots normally require a direct mention or reply.
      // Dedicated channels can opt out via requiresTrigger=false.
      if (!isPrimary && requiresTrigger && !thisBotMentioned) return;

      // Step 5: For primary bot, skip if a secondary bot was mentioned instead
      if (isPrimary) {
        for (const otherBot of this.bots) {
          if (otherBot === bot) continue;
          const otherId = otherBot.client.user?.id;
          if (
            otherId &&
            (message.mentions.users.has(otherId) ||
              content.includes(`<@${otherId}>`) ||
              content.includes(`<@!${otherId}>`) ||
              message.mentions.roles.some(
                (role) => role.tags?.botId === otherId,
              ))
          ) {
            return; // Let the other bot handle it
          }
        }
      }

      // Step 6: Translate @mention to trigger format
      if (botId && thisBotMentioned) {
        // Remove user mentions
        content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
        // Remove role mentions for this bot's managed role
        const botRoleId = message.mentions.roles.find(
          (r) => r.tags?.botId === botId,
        )?.id;
        if (botRoleId) {
          content = content
            .replace(new RegExp(`<@&${botRoleId}>`, 'g'), '')
            .trim();
        }
        // Find the group's trigger for this bot
        const triggerName = registeredGroup?.trigger || `@${bot.label}`;
        const triggerPattern = new RegExp(
          `^${triggerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`,
          'i',
        );
        // Trigger at front, reply context after
        if (!triggerPattern.test(content)) {
          content = replyContext
            ? `${triggerName} ${content} ${replyContext}`
            : `${triggerName} ${content}`;
        } else if (replyContext) {
          content = `${replyContext} ${content}`;
        }
      } else if (replyContext) {
        content = `${replyContext} ${content}`;
      }

      // Step 7: Handle attachments
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/'))
              return `[Image: ${att.name || 'image'}]`;
            if (contentType.startsWith('video/'))
              return `[Video: ${att.name || 'video'}]`;
            if (contentType.startsWith('audio/'))
              return `[Audio: ${att.name || 'audio'}]`;
            return `[File: ${att.name || 'file'}]`;
          },
        );
        content = content
          ? `${content}\n${attachmentDescriptions.join('\n')}`
          : attachmentDescriptions.join('\n');
      }

      // Store chat metadata
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName, bot: bot.label },
          'Message from unregistered Discord channel',
        );
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName, bot: bot.label },
        'Discord message stored',
      );
    });

    bot.client.on(Events.Error, (err) => {
      logger.error(
        { err: err.message, bot: bot.label },
        'Discord client error',
      );
    });
  }

  async connect(): Promise<void> {
    // Create primary bot
    const primaryClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    const primaryBot: BotClient = {
      client: primaryClient,
      token: this.primaryToken,
      label: 'primary',
    };
    this.bots.push(primaryBot);

    for (const additionalBot of loadDiscordServiceBots()) {
      const additionalClient = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
      });
      this.bots.push({
        client: additionalClient,
        token: additionalBot.token,
        label: additionalBot.label,
      });
    }

    // Setup message handlers
    for (let i = 0; i < this.bots.length; i++) {
      this.setupMessageHandler(this.bots[i], i === 0);
    }

    logger.debug(
      {
        botCount: this.bots.length,
        labels: this.bots.map((bot) => bot.label),
      },
      'Starting Discord bot connections',
    );

    // Connect all bots
    const connectPromises = this.bots.map(
      (bot) =>
        new Promise<void>((resolve, reject) => {
          let settled = false;
          const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            const error = new Error(
              `Discord bot login timed out after ${BOT_LOGIN_TIMEOUT_MS}ms`,
            );
            logger.error(
              {
                label: bot.label,
                timeoutMs: BOT_LOGIN_TIMEOUT_MS,
              },
              'Discord bot login timed out',
            );
            reject(error);
          }, BOT_LOGIN_TIMEOUT_MS);

          bot.client.once(Events.ClientReady, (readyClient) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            bot.botUserId = readyClient.user.id;
            logger.info(
              {
                username: readyClient.user.tag,
                id: readyClient.user.id,
                label: bot.label,
              },
              'Discord bot connected',
            );
            console.log(
              `\n  Discord bot: ${readyClient.user.tag} (${bot.label})`,
            );
            console.log(
              `  Use /chatid command or check channel IDs in Discord settings\n`,
            );
            resolve();
          });

          logger.debug({ label: bot.label }, 'Discord bot login starting');

          bot.client.login(bot.token).catch((err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            logger.error({ err, label: bot.label }, 'Discord bot login failed');
            reject(err);
          });
        }),
    );

    const results = await Promise.allSettled(connectPromises);
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        logger.error(
          {
            label: this.bots[i]?.label,
            err: result.reason,
          },
          'Discord bot connection failed',
        );
      }
    }
  }

  private async getOrCreateWebhook(
    textChannel: TextChannel,
    channelId: string,
  ): Promise<DiscordWebhook | null> {
    const cached = this.webhookCache.get(channelId);
    if (cached) return cached;

    try {
      const existing = await textChannel.fetchWebhooks?.();
      const reusable = existing?.find?.(
        (hook) => hook.token != null && hook.name === 'NanoClaw Personas',
      );
      if (reusable) {
        this.webhookCache.set(channelId, reusable as unknown as DiscordWebhook);
        return reusable as unknown as DiscordWebhook;
      }

      const created = await textChannel.createWebhook?.({
        name: 'NanoClaw Personas',
      });
      if (created) {
        this.webhookCache.set(channelId, created as unknown as DiscordWebhook);
        return created as unknown as DiscordWebhook;
      }
    } catch (err) {
      logger.error(
        { channelId, err },
        'Failed to get or create Discord webhook',
      );
    }

    return null;
  }

  async sendMessage(
    jid: string,
    text: string,
    opts?: { sender?: string },
  ): Promise<void> {
    const sender = opts?.sender?.trim();
    const personaBot = this.getPersonaBotForSender(jid, sender);
    const bot = personaBot || this.getBotForJid(jid);
    if (!bot?.client) {
      logger.warn({ jid }, 'No Discord bot found for JID');
      return;
    }

    try {
      // Extract channel ID from JID (dc:channelId or dc:channelId:botLabel)
      const channelId = jid.replace(/^dc:/, '').split(':')[0];
      const channel = await bot.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;
      const MAX_LENGTH = 2000;
      const normalizedText = normalizeDiscordPersonaText(text, sender);
      const personaMode = this.getPersonaMode(jid);
      const webhook = sender
        ? personaBot
          ? null
          : personaMode === 'hybrid'
            ? await this.getOrCreateWebhook(textChannel, channelId)
            : null
        : null;

      if (sender && !personaBot && personaMode === 'bot_only') {
        logger.warn(
          { jid, sender },
          'Persona sender has no mapped real bot; sending through default bot',
        );
      }

      if (webhook && sender) {
        for (let i = 0; i < normalizedText.length; i += MAX_LENGTH) {
          await webhook.send({
            content: normalizedText.slice(i, i + MAX_LENGTH),
            username: sender.slice(0, 80),
          });
        }
      } else if (normalizedText.length <= MAX_LENGTH) {
        await textChannel.send(normalizedText);
      } else {
        for (let i = 0; i < normalizedText.length; i += MAX_LENGTH) {
          await textChannel.send(normalizedText.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info(
        {
          jid,
          length: normalizedText.length,
          bot: bot.label,
          sender,
          delivery: personaBot ? 'real-bot' : webhook ? 'webhook' : 'default',
        },
        'Discord message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.bots.length > 0 && this.bots.some((b) => b.client.isReady());
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    for (const bot of this.bots) {
      bot.client.destroy();
      logger.info({ label: bot.label }, 'Discord bot stopped');
    }
    this.bots = [];
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const bot = this.getBotForJid(jid);
    if (!bot?.client) return;
    try {
      const channelId = jid.replace(/^dc:/, '').split(':')[0];
      const channel = await bot.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }

  // --- Workflow Thread Support ---

  async createThread(jid: string, name: string): Promise<string | null> {
    const bot = this.getBotForJid(jid);
    if (!bot?.client) return null;
    try {
      const channelId = jid.replace(/^dc:/, '').split(':')[0];
      const channel = await bot.client.channels.fetch(channelId);
      if (!channel || !('threads' in channel)) return null;

      const textChannel = channel as TextChannel;
      const thread = await textChannel.threads.create({
        name: name.slice(0, 100), // Discord thread name limit
        autoArchiveDuration: 1440, // 24 hours
      });
      logger.info({ jid, threadId: thread.id, name }, 'Discord thread created');
      return thread.id;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to create Discord thread');
      return null;
    }
  }

  async sendToThread(threadId: string, text: string): Promise<void> {
    // Use first available bot to send to thread
    const bot = this.bots[0];
    if (!bot?.client) return;
    try {
      const thread = await bot.client.channels.fetch(threadId);
      if (!thread || !('send' in thread)) return;

      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await (thread as TextChannel).send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await (thread as TextChannel).send(text.slice(i, i + MAX_LENGTH));
        }
      }
    } catch (err) {
      logger.error({ threadId, err }, 'Failed to send to Discord thread');
    }
  }

  async editMessage(
    channelId: string,
    messageId: string,
    newText: string,
  ): Promise<void> {
    const bot = this.bots[0];
    if (!bot?.client) return;
    try {
      const channel = await bot.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      if (msg.editable) {
        await msg.edit(newText.slice(0, 2000));
      }
    } catch (err) {
      logger.error(
        { channelId, messageId, err },
        'Failed to edit Discord message',
      );
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  logger.debug(
    { hasPrimaryToken: Boolean(token) },
    'Discord primary token presence checked',
  );
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
