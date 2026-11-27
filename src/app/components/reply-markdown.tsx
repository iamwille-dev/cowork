import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import { CheckIcon, DocumentDuplicateIcon, ExclamationCircleIcon } from '@heroicons/react/24/outline';
import type { Element, ElementContent, Root } from 'hast';
import { useEffect, useState, type ComponentProps, type RefObject } from 'react';
import { Button } from './button';

const lineContainers = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'th', 'td']);
const blockTags = new Set([...lineContainers, 'ul', 'ol', 'blockquote', 'pre', 'table', 'hr']);

function splitAtLineBreaks(children: ElementContent[]): ElementContent[][] {
  const lines: ElementContent[][] = [[]];
  for (const [index, child] of children.entries()) {
    let parts: ElementContent[][] = [[child]];
    if (child.type === 'text' || child.type === 'raw') {
      parts = child.value.split('\n').map((value) => value ? [{ ...child, value }] : []);
    } else if (child.type === 'element') {
      if (child.tagName === 'br') {
        // Markdown's hard-break handler already inserts a newline after <br>.
        const next = children[index + 1];
        if (next?.type === 'text' && next.value.startsWith('\n')) continue;
        parts = [[], []];
      } else {
        const nested = splitAtLineBreaks(child.children);
        if (nested.length > 1) parts = nested.map((children) => [{ ...child, children }]);
      }
    }
    const [first, ...remaining] = parts;
    lines[lines.length - 1].push(...first);
    lines.push(...remaining);
  }
  return lines;
}

function inlineText(child: ElementContent): string {
  if (child.type === 'element') return child.children.map(inlineText).join('');
  return child.type === 'text' || child.type === 'raw' ? child.value : '';
}

function wrapLines(children: ElementContent[], code: boolean): ElementContent[] {
  const lines = splitAtLineBreaks(children).map((parts) => ({
    parts,
    hasText: parts.map(inlineText).join('').trim().length > 0,
  }));
  if (code) {
    // The Markdown renderer supplies a trailing newline for fenced code.
    if (lines.at(-1)?.parts.length === 0) lines.pop();
  } else {
    const start = lines.findIndex((line) => line.hasText);
    if (start === -1) return children;
    lines.splice(lines.findLastIndex((line) => line.hasText) + 1);
    lines.splice(0, start);
  }
  return lines.map(({ parts, hasText }) => ({
    type: 'element',
    tagName: 'span',
    properties: hasText ? { dataReplyLine: true } : { className: ['chat-reply-blank'] },
    children: parts,
  }));
}

function groupReplyLines() {
  return (root: Root) => {
    function visit(parent: Root | Element) {
      for (const child of parent.children) {
        if (child.type === 'element') visit(child);
      }
      if (parent.type !== 'element') return;
      if (parent.tagName === 'pre') {
        const code = parent.children.find((child): child is Element => child.type === 'element' && child.tagName === 'code');
        if (code) code.children = wrapLines(code.children, true);
      } else if (lineContainers.has(parent.tagName)) {
        // A tight list item can contain both inline text and a nested list.
        const grouped: ElementContent[] = [];
        let inline: ElementContent[] = [];
        for (const child of parent.children) {
          if (child.type === 'element' && blockTags.has(child.tagName)) {
            grouped.push(...wrapLines(inline, false), child);
            inline = [];
          } else {
            inline.push(child);
          }
        }
        parent.children = [...grouped, ...wrapLines(inline, false)];
      }
    }
    visit(root);
  };
}

type MarkdownSpan = ComponentProps<'span'> & { node?: Element };

function ReplySpan({ node, ...props }: MarkdownSpan) {
  if (!node?.properties.dataReplyLine) return <span {...props} />;
  return <span className="chat-reply-text" onDoubleClick={(event) => selectText(event.currentTarget)}>{props.children}</span>;
}

function selectText(element: HTMLElement | null) {
  const selection = window.getSelection();
  if (!selection || !element) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function CopyReply({ text, body }: { text: string; body: RefObject<HTMLDivElement | null> }) {
  const [status, setStatus] = useState<'copied' | 'failed'>();
  useEffect(() => {
    if (!status) return;
    const timeout = window.setTimeout(() => setStatus(undefined), 2600);
    return () => window.clearTimeout(timeout);
  }, [status]);

  async function copyReply() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('copied');
    } catch {
      selectText(body.current);
      setStatus('failed');
    }
  }

  const Icon = status === 'copied' ? CheckIcon : status === 'failed' ? ExclamationCircleIcon : DocumentDuplicateIcon;
  const feedback = status === 'copied' ? 'Reply copied.' : status === 'failed' ? 'Reply selected. Use your keyboard to copy.' : '';
  return (
    <div className="chat-reply-actions">
      <Button variant="icon" className="chat-reply-copy" aria-label="Copy reply" title={feedback || 'Copy reply'}
        data-copy-status={status} onClick={copyReply}>
        <Icon aria-hidden="true" />
      </Button>
      <span className="sr-only" role="status">{feedback}</span>
    </div>
  );
}

const replyComponents = { span: ReplySpan };
const replyPlugins = [groupReplyLines];

export function ReplyMarkdown() {
  return <MarkdownTextPrimitive components={replyComponents} rehypePlugins={replyPlugins} disallowedElements={['img']} />;
}
