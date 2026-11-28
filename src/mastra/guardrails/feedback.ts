import { TripWire } from '@mastra/core/agent';
import type { ProcessorContext } from '@mastra/core/processors';

export const guardrailMessages = {
  injection: 'I can’t follow instructions that try to override the agent’s rules or access private information. Please rephrase your request.',
  moderation: 'I can’t continue with that content. You can rephrase your request and try again.',
  unavailable: 'Cowork couldn’t complete a safety check. Please try again shortly.',
} as const;

export function guardrailAbort(rejection: 'injection' | 'moderation'): ProcessorContext['abort'] {
  const prefix = rejection === 'injection' ? 'Prompt injection detected' : 'Content flagged for moderation';
  return (reason) => { throw new TripWire(reason?.startsWith(prefix) ? guardrailMessages[rejection] : guardrailMessages.unavailable); };
}

export function guardrailReply(tripwire: { reason?: string }) {
  return Object.values(guardrailMessages).find((message) => message === tripwire.reason) ?? guardrailMessages.unavailable;
}
