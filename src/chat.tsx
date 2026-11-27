import {
  AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive,
  useAuiState, useExternalStoreRuntime, type ThreadMessageLike,
} from '@assistant-ui/react';
import { useChat } from '@chat-adapter/web/react';
import { SparklesIcon } from '@heroicons/react/24/outline';
import { useRef, useState } from 'react';
import { buttonClassName } from './app/components/button';
import { fieldClassName } from './app/components/input';
import { ReplyMarkdown } from './app/components/reply-markdown';
import { ConversationTaskReview, type Task } from './app/components/tasks';

type WorkspaceMessage = { Author: string; Text: string; At: string; SenderID?: string; Agent?: boolean };
type ConversationProps = {
  role: string;
  agentName?: string;
  viewer: string;
  threadId: string;
  guest?: boolean;
  readOnly?: boolean;
  channel?: 'Slack' | 'Telegram';
  messages: WorkspaceMessage[];
  tasks?: Task[];
  send: (transport: () => Promise<void>) => Promise<void>;
};

function AgentMark({ className = '' }: { className?: string }) {
  return <span className={`chat-agent-mark ${className}`} aria-hidden="true"><SparklesIcon /></span>;
}

function ConversationMessage() {
  const message = useAuiState((state) => state.message);
  const date = message.createdAt?.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const author = String(message.metadata?.custom?.author ?? '');
  const agent = message.role === 'assistant';
  return (
    <MessagePrimitive.Root asChild>
      <article className={agent ? 'chat-turn chat-turn-agent' : 'chat-turn chat-turn-user'}>
        {agent && <AgentMark />}
        <div className="chat-turn-content">
          <div className="chat-byline">
            <strong>{author}</strong>
            {date && <time dateTime={message.createdAt?.toISOString()}>{date}</time>}
          </div>
          <div className="message-body">
            <MessagePrimitive.Parts components={agent ? { Text: ReplyMarkdown } : undefined} />
          </div>
        </div>
      </article>
    </MessagePrimitive.Root>
  );
}

const taskPrompts: Record<string, string> = {
  Developer: 'Create a task to build a launch page.',
  'Product Manager': 'Create a task to draft a launch brief.',
  'Sales Lead': 'Create a task to draft a prospect follow-up.',
  'Social Media': 'Create a task to plan next week’s posts.',
};

function ConversationStart({ role }: { role: string }) {
  return (
    <ThreadPrimitive.Empty>
      <div className="chat-empty">
        <AgentMark className="chat-agent-mark-large" />
        <h2>What are we working on?</h2>
        <p>Start with a question, a task, or something to remember.</p>
        <div className="chat-suggestions">
          <ThreadPrimitive.Suggestion prompt={taskPrompts[role] ?? 'Create a task to plan the launch.'} send={false}>
            <span aria-hidden="true">▤</span> Draft a task
          </ThreadPrimitive.Suggestion>
          <ThreadPrimitive.Suggestion prompt="Remind me to review the launch tomorrow at 10 am." send={false}>
            <span aria-hidden="true">◴</span> Set a reminder
          </ThreadPrimitive.Suggestion>
        </div>
      </div>
    </ThreadPrimitive.Empty>
  );
}

export function Conversation({ role, agentName, viewer, threadId, guest, readOnly, channel, messages, tasks = [], send }: ConversationProps) {
  const [pending, setPending] = useState<{ message: WorkspaceMessage; before: number } | null>(null);
  const error = useRef<Error | undefined>(undefined);
  const chat = useChat({ api: '/api/web-chat', onError: (failure) => { error.current = failure; } });
  const runtime = useExternalStoreRuntime({
    messages: pending && messages.length === pending.before ? [...messages, pending.message] : messages,
    convertMessage: (message: WorkspaceMessage, index?: number): ThreadMessageLike => ({
      id: message.At + '-' + (index ?? message.Author),
      role: message.Agent || (!message.SenderID && message.Author === role + ' agent') ? 'assistant' : 'user',
      content: message.Text,
      createdAt: new Date(message.At),
      metadata: { custom: { author: message.Author } },
    }),
    isRunning: Boolean(pending),
    onNew: async (message) => {
      if (readOnly) return;
      const text = message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n').trim();
      if (!text) return;
      setPending({
        before: messages.length,
        message: { Author: viewer, Text: text, At: new Date().toISOString(), SenderID: 'pending' },
      });
      try {
        await send(async () => {
          error.current = undefined;
          try {
            await chat.sendMessage({ text }, {
              headers: { 'X-Cowork-Time-Zone': Intl.DateTimeFormat().resolvedOptions().timeZone, 'X-Cowork-Thread': threadId, ...(guest && { 'X-Cowork-Guest': '1' }) },
            });
            if (error.current) throw error.current;
          } finally {
            chat.setMessages([]);
          }
        });
      } finally {
        setPending(null);
      }
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="conversation-shell">
        <ThreadPrimitive.Viewport className="conversation-viewport" aria-label="Conversation history">
          <ConversationStart role={role} />
          <div className="chat-transcript" role="log" aria-label="Messages">
            <ThreadPrimitive.Messages components={{ Message: ConversationMessage }} />
            <ThreadPrimitive.If running>
              <div className="chat-thinking" role="status">
                <AgentMark />
                <span className="chat-activity" aria-hidden="true"><i /><i /><i /></span>
                <span className="sr-only">Waiting for {agentName ?? `the ${role} agent`}</span>
              </div>
            </ThreadPrimitive.If>
          </div>
          {!guest && <ConversationTaskReview tasks={tasks} />}
        </ThreadPrimitive.Viewport>
        <div className="chat-dock">
          <ThreadPrimitive.ScrollToBottom className="chat-latest" behavior="smooth">Latest messages</ThreadPrimitive.ScrollToBottom>
          {readOnly ? <p className="px-4 py-2 text-sm">Reply in {channel ?? 'the linked channel'}.</p> : <ComposerPrimitive.Root className="chat-composer">
            <ComposerPrimitive.Input className={fieldClassName()} aria-label="Message" placeholder="Message your agent…" rows={1} maxLength={4000} />
            <div className="chat-composer-actions">
              <ComposerPrimitive.Send className={buttonClassName('primary', 'chat-send')} aria-label="Send message">Send</ComposerPrimitive.Send>
            </div>
          </ComposerPrimitive.Root>}
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
