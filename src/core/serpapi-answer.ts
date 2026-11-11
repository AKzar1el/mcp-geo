// SerpAPI returns answer content in nested text/list blocks, separate from
// citations, links, and other provider metadata. Only traverse visible answer fields.
export interface SerpApiAnswerBlock {
  type?: string;
  title?: string;
  snippet?: string;
  text?: string;
  table?: unknown;
  product_labels?: unknown;
  comparison?: unknown;
  list?: SerpApiAnswerBlock[];
  text_blocks?: SerpApiAnswerBlock[];
}

export function flattenSerpApiReferences(
  refs: Array<{ link?: unknown }> | undefined,
): string[] {
  if (!Array.isArray(refs)) return [];
  const urls: string[] = [];
  for (const ref of refs) {
    if (!ref || typeof ref.link !== 'string') continue;
    try {
      const parsed = new URL(ref.link);
      // Provider metadata is evidence only when it points to a web source.
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
          parsed.hostname && !parsed.username && !parsed.password) {
        urls.push(ref.link);
      }
    } catch {
      // Bare domains and malformed references cannot be cited as links.
    }
  }
  return urls;
}

const MAX_DEPTH = 24;
const MAX_BLOCKS = 2048;
export const MAX_SERPAPI_ANSWER_TEXT_LENGTH = 250_000;

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
    if (length > MAX_SERPAPI_ANSWER_TEXT_LENGTH) {
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

    // Count visible cells before joining; provider metadata never becomes answer text.
    const addRow = (rawCells: unknown[], leadingCell?: unknown): void => {
      const cells: string[] = [];
      let rowLength = 0;
      const addCell = (cell: unknown): void => {
        count += 1;
        if (count > MAX_BLOCKS) {
          throw new Error('SerpAPI answer exceeds structured-text nesting limit');
        }
        const value = visibleText(cell);
        if (!value) return;
        rowLength += value.length + (cells.length ? 3 : 0);
        if (length + rowLength > MAX_SERPAPI_ANSWER_TEXT_LENGTH) {
          throw new Error('SerpAPI answer exceeds structured-text size limit');
        }
        cells.push(value);
      };
      if (leadingCell !== undefined) addCell(leadingCell);
      for (const cell of rawCells) addCell(cell);
      if (cells.length > 0) add(cells.join(' | '));
    };

    if (Array.isArray(block.table)) {
      for (const row of block.table) {
        if (Array.isArray(row)) addRow(row);
      }
    }

    // SerpAPI comparison blocks expose product labels and feature/value rows.
    if (block.type === 'comparison') {
      if (Array.isArray(block.product_labels)) addRow(block.product_labels);
      if (Array.isArray(block.comparison)) {
        for (const entry of block.comparison) {
          count += 1;
          if (count > MAX_BLOCKS) {
            throw new Error('SerpAPI answer exceeds structured-text nesting limit');
          }
          if (!entry || typeof entry !== 'object') continue;
          const row = entry as { feature?: unknown; values?: unknown };
          addRow(Array.isArray(row.values) ? row.values : [], row.feature);
        }
      }
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
