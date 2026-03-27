import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

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

export class DiscordChannel implements Channel {
  name = 'discord';

  private bots: BotClient[] = [];
  private opts: DiscordChannelOpts;
  private primaryToken: string;

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

      // Step 4: For secondary bots, only process if THIS bot was mentioned
      if (!isPrimary && !thisBotMentioned) return;

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
        const group = this.opts.registeredGroups()[chatJid];
        const triggerName = group?.trigger || `@${bot.label}`;
        // Trigger at front, reply context after
        content = replyContext
          ? `${triggerName} ${content} ${replyContext}`
          : `${triggerName} ${content}`;
      } else if (replyContext) {
        content = `${content} ${replyContext}`;
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

    // Discover additional bot tokens from env and .env file: DISCORD_BOT_TOKEN_<LABEL>
    // Read all DISCORD_BOT_TOKEN_* from .env file
    const envFileContent = readEnvFile([
      'DISCORD_BOT_TOKEN_WORKSHOP',
      'DISCORD_BOT_TOKEN_RESEARCH',
      'DISCORD_BOT_TOKEN_SUPPORT',
      'DISCORD_BOT_TOKEN_ADMIN',
      'DISCORD_BOT_TOKEN_PLANNING',
    ]);
    const allEnv = { ...envFileContent, ...process.env };
    for (const [key, value] of Object.entries(allEnv)) {
      if (
        key.startsWith('DISCORD_BOT_TOKEN_') &&
        value &&
        key !== 'DISCORD_BOT_TOKEN'
      ) {
        const label = key.replace('DISCORD_BOT_TOKEN_', '').toLowerCase();
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
          token: value,
          label,
        });
      }
    }

    // Setup message handlers
    for (let i = 0; i < this.bots.length; i++) {
      this.setupMessageHandler(this.bots[i], i === 0);
    }

    // Connect all bots
    const connectPromises = this.bots.map(
      (bot) =>
        new Promise<void>((resolve) => {
          bot.client.once(Events.ClientReady, (readyClient) => {
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
          bot.client.login(bot.token);
        }),
    );

    await Promise.all(connectPromises);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const bot = this.getBotForJid(jid);
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
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info(
        { jid, length: text.length, bot: bot.label },
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
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
