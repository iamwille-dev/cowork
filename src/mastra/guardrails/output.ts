import { BatchPartsProcessor, type Processor } from '@mastra/core/processors';
import { TripWire } from '@mastra/core/agent';
import { moderation } from '../processors/moderation.ts';
import { guardrailAbort, guardrailMessages, guardrailReply } from './feedback.ts';
import { redactOnly, systemPromptScrubber } from './system-prompt.ts';

const outputGuardrails = {
  id: 'cowork-output-guardrails',
  async processOutputStream({ part, abort, ...args }) {
    if (part.type !== 'text-delta' || !part.payload.text.trim()) return part;
    const text = part.payload.text;
    try {
      const [scrubbed] = await Promise.all([
        systemPromptScrubber.processOutputStream({ ...args, part, streamParts: [part], abort: () => { throw new TripWire(guardrailMessages.unavailable); } }),
        moderation.processOutputStream({ ...args, part, streamParts: [part], abort: guardrailAbort('moderation') }),
      ]);
      if (scrubbed?.type !== 'text-delta') return null;
      return { ...scrubbed, payload: { ...scrubbed.payload, text: redactOnly(text, scrubbed.payload.text) } };
    } catch (error) {
      return abort(error instanceof TripWire ? guardrailReply({ reason: error.message }) : guardrailMessages.unavailable);
    }
  },
} satisfies Processor;

// Hold adjacent text deltas until the end of the text block. Tool progress can still stream.
export const guardedOutput = [new BatchPartsProcessor({ batchSize: Number.MAX_SAFE_INTEGER }), outputGuardrails];
