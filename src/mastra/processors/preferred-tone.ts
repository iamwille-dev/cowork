import type { Processor, ProcessInputArgs } from '@mastra/core/processors';

const tones = /\b(?:brief|casual|concise|conversational|direct|empathetic|formal|friendly|plainspoken|professional|technical|warm)\b/gi;
const preference = /\b(?:prefer\w*|likes?|wants?|asks? for)\b/i;
const responseStyle = /\b(?:tone|style|repl(?:y|ies)|responses?|communication|answers?|explanations?)\b/i;

export const preferredTone = {
  id: 'preferred-tone',
  processInput({ messages, systemMessages, requestContext }: ProcessInputArgs) {
    const memory = requestContext?.getRaw('agentMemory');
    // Use known style words only. Personal notes remain data, regardless of their wording.
    const notes = Array.isArray(memory) ? memory.filter((item): item is string => typeof item === 'string') : [];
    const saved = notes.flatMap((note) => preference.test(note) && responseStyle.test(note) &&
      !/\b(?:avoid|never|not|no longer|dislikes?)\b/i.test(note) ? (note.toLowerCase().match(tones) ?? []) : []);
    const styles = [...new Set(saved)];
    const content = [
      'Follow the current participant’s explicit tone and verbosity preferences in the latest request. Fit the tone to the situation and keep the substance accurate.',
      styles.length ? `When the current request leaves the tone open, use these saved style preferences where appropriate: ${styles.join(', ')}.` : '',
    ].filter(Boolean).join(' ');
    return { messages, systemMessages: [...systemMessages, { role: 'system' as const, content }] };
  },
} satisfies Processor;
