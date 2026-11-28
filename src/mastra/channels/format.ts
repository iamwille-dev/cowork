import { parseMarkdown } from 'chat';

export const channelReplyGuidance = 'Format replies as standard Markdown. Write prose and lists directly, and reserve code fences for code.';

export function normalizeChannelReply(reply: string): string {
  const markdown = reply.trim();
  if (!/^(?:`{3,}|~{3,})/.test(markdown)) return markdown;

  const { children: [fence, ...rest] } = parseMarkdown(markdown);
  if (rest.length || fence?.type !== 'code') return markdown;

  // Some replies wrap a complete conversational answer in a syntax fence.
  const { children: [intro, ...body] } = parseMarkdown(fence.value);
  const hasProse = intro?.type === 'paragraph' && intro.children.some((part) =>
    part.type === 'text' && /\p{L}+[ \t]+\p{L}+[ \t]+[^\n]*[.!?:](?:\s|$)/u.test(part.value));
  return hasProse && body.some((part) => part.type === 'list') ? fence.value.trim() : markdown;
}
