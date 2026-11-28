import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { TelegramAdapter, createTelegramAdapter, type TelegramMessage } from '@chat-adapter/telegram';
import type { Mastra } from '@mastra/core';
import type { ChannelHandler, SlashCommandChannelHandler } from '@mastra/core/channels';
import type { ChatInstance, WebhookOptions } from 'chat';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { workspaceAgentRole } from '../agents/roles.ts';
import { inChannelThread, sharedChannelMemory } from '../memory/multi-user-thread.ts';
import { roleAgentId } from './agents.ts';
import { telegramBridgeSecret } from './telegram-auth.ts';

type Installation = { WorkspaceID: string; Agent: string; Role: string; Version: string; Token: string; Username: string };
const delivery = new AsyncLocalStorage<Installation>();
const installationIdPattern = /^[a-f0-9]{48}$/;
const webhookRoute = '/api/agents/:agent/channels/telegram/webhook';

export function telegramInstallationId() {
  return delivery.getStore()?.Version;
}

function bridge(path: string, data?: object) {
  const secret = telegramBridgeSecret();
  if (!secret) throw new Error('Telegram is unavailable.');
  return fetch('http://127.0.0.1:4000/internal/telegram/' + path, {
    method: data ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${secret}`, ...(data && { 'Content-Type': 'application/json' }) },
    body: data && JSON.stringify(data),
    signal: AbortSignal.timeout(path === 'message' ? 185_000 : 10_000),
  });
}

function webhookSecret(version: string, secret: string) {
  return createHmac('sha256', secret).update('cowork-telegram-webhook\0' + version).digest('hex');
}

// The registered agent owns the SDK and its handlers. Each installation uses
// the official adapter with its own token, identity and webhook verification.
export class CoworkTelegramAdapter extends TelegramAdapter {
  private sdkInstance?: ChatInstance;
  private webhooks = new Map<string, Promise<TelegramAdapter>>();

  constructor() {
    super({ mode: 'webhook', secretToken: 'cowork-installation-router', botToken: () => {
      throw new Error('Telegram requires a Cowork installation.');
    } });
  }

  override async initialize(chat: ChatInstance) {
    this.sdkInstance = chat;
  }

  private async attach(installation: Installation, secret?: string) {
    if (!this.sdkInstance) throw new Error('The agent’s Telegram channel is not initialized.');
    const adapter = createTelegramAdapter({
      botToken: installation.Token,
      userName: installation.Username,
      mode: secret ? 'webhook' : 'polling',
      secretToken: secret,
      mentionOnReply: true,
      persistThreadHistory: false,
      longPolling: { allowedUpdates: ['message'], limit: 1, deleteWebhook: false },
    });
    try {
      await adapter.initialize(this.sdkInstance);
      return adapter;
    } catch (error) {
      await adapter.disconnect();
      throw error;
    }
  }

  startPollingInstallation(installation: Installation) {
    return delivery.run(installation, () => this.attach(installation));
  }

  override async handleWebhook(request: Request, options?: WebhookOptions) {
    const installation = delivery.getStore();
    const secret = telegramBridgeSecret();
    if (!installation || !secret) return new Response(null, { status: 401 });
    let adapter = this.webhooks.get(installation.Version);
    if (!adapter) {
      if (this.webhooks.size >= 128) this.webhooks.delete(this.webhooks.keys().next().value!);
      adapter = this.attach(installation, webhookSecret(installation.Version, secret));
      this.webhooks.set(installation.Version, adapter);
      void adapter.catch(() => this.webhooks.delete(installation.Version));
    }
    return (await adapter).handleWebhook(request, options);
  }
}

function telegramMessage(raw: unknown) {
  const message = raw as TelegramMessage | undefined;
  return message?.from && !message.from.is_bot && (message.chat?.type === 'group' || message.chat?.type === 'supergroup')
    ? message : undefined;
}

async function replyFor(installation: Installation, message: TelegramMessage, topic: string,
  text: string, reply: boolean, post: (text: string) => Promise<unknown>,
) {
  const { WorkspaceID, Agent, Version } = installation;
  const memory = sharedChannelMemory({ Channel: 'telegram', WorkspaceID, Installation: Version, Agent, Conversation: topic });
  await inChannelThread(memory.thread, async () => {
    const response = await bridge('message', {
      WorkspaceID, Agent, Version,
      ChatID: String(message.chat.id), Topic: topic, Title: message.chat.title,
      MessageID: String(message.message_id), SenderID: String(message.from!.id),
      Author: [message.from!.first_name, message.from!.last_name].filter(Boolean).join(' '),
      Text: text, At: new Date(message.date * 1000), Reply: reply,
    });
    if (!response.ok) throw new Error(`Cowork could not process Telegram message (HTTP ${response.status}).`);
    const result = await response.json() as { reply?: string };
    if (result.reply) await post(result.reply);
  });
}

export const handleTelegramMessage: ChannelHandler = async (thread, message) => {
  const installation = delivery.getStore();
  const raw = telegramMessage(message.raw);
  if (!installation || !raw || message.author.isMe || !message.text.trim()) return;
  await replyFor(installation, raw, thread.id, message.text, Boolean(message.isMention || message.replyTo?.author.isMe),
    (markdown) => thread.post({ markdown }));
};

export const handleTelegramCommand: SlashCommandChannelHandler = async (event) => {
  const installation = delivery.getStore();
  const raw = telegramMessage(event.raw);
  if (!installation || !raw || event.user.isMe || !(event.adapter instanceof TelegramAdapter)) return;
  const adapter = event.adapter;
  const chatId = String(raw.chat.id);
  const topic = adapter.encodeThreadId({ chatId, messageThreadId: raw.is_topic_message ? raw.message_thread_id : undefined });
  const text = event.text.trim();
  if (event.command === '/start' && installationIdPattern.test(text)) {
    const response = await bridge('link', {
      WorkspaceID: installation.WorkspaceID, Agent: installation.Agent, Version: installation.Version,
      Code: text, ChatID: chatId, Title: raw.chat.title,
    });
    if (!response.ok) throw new Error('Cowork could not link this Telegram group.');
    if ((await response.json() as { linked: boolean }).linked) {
      await adapter.postMessage(topic, `Connected to Cowork. Use /ask@${installation.Username} followed by your message, or reply to the bot.`);
    }
  } else if (event.command === '/ask' && text) {
    await replyFor(installation, raw, topic, text, true, (markdown) => adapter.postMessage(topic, { markdown }));
  }
};

export function createTelegramHandler(mastra: Mastra) {
  const app = new Hono();
  app.post(webhookRoute, bodyLimit({ maxSize: 256 * 1024 }), async (context) => {
    const version = context.req.query('installation') ?? '';
    const secret = telegramBridgeSecret();
    const provided = context.req.header('x-telegram-bot-api-secret-token') ?? '';
    if (!secret || !installationIdPattern.test(version) || !/^[a-f0-9]{64}$/.test(provided) ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(webhookSecret(version, secret)))) {
      return context.json({ error: 'Invalid Telegram webhook.' }, 401);
    }
    const response = await bridge('installation?version=' + version);
    if (response.status === 404) return context.json({ ok: true });
    if (!response.ok) return context.json({ error: 'Telegram settings unavailable.' }, 503);
    const installation = await response.json() as Installation;
    if (roleAgentId(installation.Role) !== context.req.param('agent')) return context.json({ error: 'Telegram agent mismatch.' }, 404);
    const channels = mastra.getAgent(workspaceAgentRole(installation.Role)).getChannels();
    if (!channels) return context.json({ error: 'Telegram channel unavailable.' }, 503);
    await channels.initialize(mastra);
    return delivery.run(installation, () => channels.handleWebhookEvent('telegram', context.req.raw, {
      waitUntil: (task) => { void task.catch(() => console.error('Cowork could not process a Telegram event.')); },
    }));
  });
  return app.fetch;
}

export function startTelegram(mastra: Mastra) {
  if (!telegramBridgeSecret()) return;
  const active = new Map<string, TelegramAdapter>();
  async function reconcile() {
    try {
      const response = await bridge('installations');
      if (!response.ok) throw new Error('Telegram settings unavailable.');
      // Keep polling installations working locally and for existing bots.
      const desired = new Map((await response.json() as Installation[]).map((item) => [item.Version + ':' + item.Role, item]));
      for (const [id, adapter] of active) {
        if (desired.has(id)) continue;
        await adapter.disconnect();
        active.delete(id);
      }
      await Promise.all([...desired].map(async ([id, installation]) => {
        if (active.has(id)) return;
        try {
          const channels = mastra.getAgent(workspaceAgentRole(installation.Role)).getChannels();
          const adapter = channels?.adapters.telegram;
          if (!channels || !(adapter instanceof CoworkTelegramAdapter)) throw new Error('Telegram channel unavailable.');
          await channels.initialize(mastra);
          active.set(id, await adapter.startPollingInstallation(installation));
        } catch {
          console.error('Cowork could not start a polling Telegram bot.');
        }
      }));
    } catch {
      console.error('Cowork could not reconcile workspace Telegram bots.');
    } finally {
      setTimeout(reconcile, 5000).unref();
    }
  }
  void reconcile();
}
