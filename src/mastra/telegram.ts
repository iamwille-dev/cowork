import { createMemoryState } from '@chat-adapter/state-memory';
import type { ChannelHandler } from '@mastra/core/channels';
import { Agent } from '@mastra/core/agent';
import { createTelegramAdapter } from '@mastra/telegram';
import type { Mastra } from '@mastra/core';

const sharedSecret = process.env.COWORK_TELEGRAM_BRIDGE_SECRET?.trim();

type Installation = { WorkspaceID: string; Version: string; Token: string };

const recordMessage = ({ WorkspaceID, Version }: Installation): ChannelHandler => async (thread, message) => {
  if (thread.isDM || message.author.isBot === true || message.author.isMe || !message.text.trim()) return;
  const chat = message.raw as { chat?: { id: number; type: string; title?: string } };
  if (chat.chat?.type !== 'group' && chat.chat?.type !== 'supergroup') return;
  const response = await fetch('http://127.0.0.1:4000/internal/telegram/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sharedSecret}` },
    body: JSON.stringify({
      WorkspaceID, Version,
      ChatID: String(chat.chat.id),
      Topic: thread.id,
      Title: chat.chat.title,
      MessageID: message.id,
      SenderID: message.author.userId,
      Author: message.author.fullName || message.author.userName,
      Text: message.text,
      At: message.metadata.dateSent,
      Reply: Boolean(message.isMention || message.replyTo?.author.isMe),
    }),
    signal: AbortSignal.timeout(185_000),
  });
  if (!response.ok) throw new Error(`Cowork could not process Telegram message (HTTP ${response.status}).`);
  const { reply } = await response.json() as { reply?: string };
  if (reply) await thread.post(reply);
};

async function connect(mastra: Mastra, installation: Installation) {
  const adapter = createTelegramAdapter({
    botToken: installation.Token,
    mode: 'polling',
    mentionOnReply: true,
    persistThreadHistory: false,
    longPolling: { allowedUpdates: ['message'], limit: 1 },
  });
  const handle = recordMessage(installation);
  const agent = new Agent({
    id: 'telegram-' + installation.WorkspaceID,
    name: 'Cowork',
    model: 'openrouter/openai/gpt-4.1-mini',
    instructions: 'Route Telegram conversations to the workspace agent.',
    channels: {
      adapters: { telegram: adapter },
      state: createMemoryState(),
      tools: false,
      handlers: {
        onMessage: handle, onMention: handle, onSubscribedMessage: handle,
        onDirectMessage: false, onSlashCommand: false, onAction: false,
      },
    },
  });
  try {
    await agent.getChannels()!.initialize(mastra);
  } catch (error) {
    await adapter.disconnect();
    throw error;
  }
  return { version: installation.Version, disconnect: () => adapter.disconnect() };
}

export function startTelegram(mastra: Mastra) {
  if (!sharedSecret) return;
  const active = new Map<string, Awaited<ReturnType<typeof connect>>>();
  async function reconcile() {
    try {
      const response = await fetch('http://127.0.0.1:4000/internal/telegram/installations', {
        headers: { Authorization: `Bearer ${sharedSecret}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Telegram settings unavailable.');
      const desired = new Map((await response.json() as Installation[]).map((item) => [item.WorkspaceID, item]));
      for (const [id, connection] of active) {
        if (desired.get(id)?.Version === connection.version) continue;
        await connection.disconnect();
        active.delete(id);
      }
      await Promise.all([...desired].map(async ([id, installation]) => {
        if (active.has(id)) return;
        try {
          active.set(id, await connect(mastra, installation));
        } catch {
          console.error('Mastra could not start a workspace Telegram bot.', id);
        }
      }));
    } catch {
      console.error('Mastra could not reconcile workspace Telegram bots.');
    } finally {
      setTimeout(reconcile, 5000).unref();
    }
  }
  void reconcile();
}
