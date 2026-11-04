// SerpAPI returns answer content in nested text/list blocks, separate from
// citations, links, and other provider metadata. Only traverse visible answer fields.
export interface SerpApiAnswerBlock {
  type?: string;
  title?: string;
  snippet?: string;
  text?: string;
  list?: SerpApiAnswerBlock[];
  text_blocks?: SerpApiAnswerBlock[];
}

const MAX_DEPTH = 24;
const MAX_BLOCKS = 2048;
const MAX_TEXT_LENGTH = 250_000;

function visibleText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function flattenSerpApiAnswer(
  blocks: SerpApiAnswerBlock[] | undefined,
  bullet = '-',
): string {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';

  const parts: string[] = [];
  const seen = new Set<object>();
  let count = 0;
  let length = 0;

  const add = (value: string): void => {
    if (!value) return;
    length += value.length;
    if (length > MAX_TEXT_LENGTH) {
      throw new Error('SerpAPI answer exceeds structured-text size limit');
    }
    parts.push(value);
  };

  const visit = (block: SerpApiAnswerBlock, depth: number, listItem: boolean): void => {
    if (!block || typeof block !== 'object') return;
    count += 1;
    if (depth > MAX_DEPTH || count > MAX_BLOCKS || seen.has(block)) {
      throw new Error('SerpAPI answer exceeds structured-text nesting limit');
    }
    seen.add(block);

    const title = visibleText(block.title);
    const body = visibleText(block.snippet) || visibleText(block.text);
    if (listItem) {
      const label = title && title !== body ? [title, body].filter(Boolean).join(' ') : body;
      if (label) add(`${bullet} ${label}`);
    } else {
      if (title && title !== body) add(title);
      add(body);
    }

    if (Array.isArray(block.text_blocks)) {
      for (const child of block.text_blocks) visit(child, depth + 1, false);
    }
    if (Array.isArray(block.list)) {
      for (const item of block.list) visit(item, depth + 1, true);
    }
  };

  for (const block of blocks) visit(block, 0, false);
  return parts.join('\n\n');
}
