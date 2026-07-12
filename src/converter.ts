/**
 * Core PDF to Markdown converter.
 * Extracts text from PDF via pdf.js, analyzes layout, and produces Markdown.
 * Works in both browser and Node.js environments.
 */
import type {
  Root,
  Content,
  PhrasingContent,
  Heading,
  Paragraph,
  List,
  ListItem,
  Code,
  Blockquote,
  Table,
  TableRow,
  Text as MdText,
} from 'mdast';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfmToMarkdown } from 'mdast-util-gfm';
import type { TxtItem, Row, FontStyle, PdfToMarkdownOptions } from './types.js';

// ── Lazy pdfjs import (handles Node.js vs browser builds) ─────────────

// Declare process for Node.js environment detection.
// This allows isomorphic usage (browser + Node.js) without @types/node.
declare const process: {
  versions: { node?: string };
} | undefined;

let pdfjsModule: { getDocument: Function; GlobalWorkerOptions: { workerSrc: string }; OPS: Record<string, number> } | null = null;

async function getPdfJs(): Promise<{ getDocument: Function; GlobalWorkerOptions: { workerSrc: string }; OPS: Record<string, number> }> {
  if (!pdfjsModule) {
    const isNode =
      typeof process !== 'undefined' &&
      process.versions != null &&
      process.versions.node != null;
    // Use the legacy build in Node.js environments. The main build
    // requires browser APIs (DOMMatrix, etc.) not available in Node.js.
    // @ts-ignore
    pdfjsModule = isNode
      ? await import('pdfjs-dist/legacy/build/pdf.mjs')
      : await import('pdfjs-dist');
  }
  return pdfjsModule;
}

// ── Constants ──────────────────────────────────────────────────────────
const BULLET_RE = /^[-•◦▪–—*+]\s+/;
const ORDERED_RE = /^\d+[.)]\s+/;
const ALL_CAPS_RE = /^[A-Z][A-Z\s()\d/-]+$/;
const SINGLE_BULLET = /^[-•◦▪–—*+]$/;
const SINGLE_NUMBER = /^\d+[.)]$/;
const URL_RE = /^https?:\/\/\S+|^[\w-]+\.[\w-]+(\/\S*)?$/;

// ── Utilities ──────────────────────────────────────────────────────────

function rowText(row: Row): string {
  return row.map(t => t.str).join(' ').trim();
}

function groupRows(items: TxtItem[], toleranceY = 4): Row[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Row[] = [];
  let cur: Row = [];
  let lastY: number | null = null;
  for (const it of sorted) {
    if (!it.str.trim()) continue;
    if (lastY === null || Math.abs(it.y - lastY) <= toleranceY) {
      cur.push(it);
      if (lastY === null) lastY = it.y;
    } else {
      rows.push(cur.sort((a, b) => a.x - b.x));
      cur = [it];
      lastY = it.y;
    }
  }
  if (cur.length) rows.push(cur.sort((a, b) => a.x - b.x));
  return rows;
}

function mode(arr: number[]): number {
  const freq: Record<number, number> = {};
  let maxFreq = 0, modeVal = arr[0] || 0;
  for (const n of arr) { freq[n] = (freq[n] || 0) + 1; if (freq[n] > maxFreq) { maxFreq = freq[n]; modeVal = n; } }
  return modeVal;
}

function bodyMargin(rows: Row[]): number {
  const xs = rows
    .filter(r => r.length > 0 && r[0].fontSize < 16)
    .map(r => Math.round(r[0].x))
    .filter(Boolean);
  return xs.length ? Math.min(...xs) : 50;
}

// ── Font style detection (width-per-character analysis) ──────────────

function buildFontStyleMap(items: TxtItem[]): Record<string, FontStyle> {
  const bucket: Record<string, { totalWpc: number; count: number }> = {};
  for (const t of items) {
    if (t.width <= 0 || t.str.length < 2 || t.isMono) continue;
    const wpc = t.width / (t.fontSize * t.str.length);
    if (!bucket[t.fontName]) bucket[t.fontName] = { totalWpc: 0, count: 0 };
    bucket[t.fontName].totalWpc += wpc;
    bucket[t.fontName].count++;
  }

  const entries = Object.entries(bucket).filter(([, v]) => v.count >= 1);
  const map: Record<string, FontStyle> = {};

  if (entries.length <= 1) {
    for (const [fn] of entries) map[fn] = { strong: false, em: false };
    return map;
  }

  const sortedByFreq = [...entries].sort((a, b) => b[1].count - a[1].count);
  const baselineEntry = sortedByFreq[0];
  const baseWpc = baselineEntry[1].totalWpc / baselineEntry[1].count;

  for (const [fn, d] of entries) {
    if (fn === baselineEntry[0]) {
      map[fn] = { strong: false, em: false };
      continue;
    }
    const avg = d.totalWpc / d.count;
    const ratio = avg / baseWpc;
    if (ratio > 1.03) {
      map[fn] = { strong: true, em: false };
    } else if (ratio < 0.85) {
      map[fn] = { strong: false, em: true };
    } else if (ratio < 0.95) {
      map[fn] = { strong: true, em: true };
    } else {
      map[fn] = { strong: true, em: false };
    }
  }

  return map;
}

// ── Heading detection ──────────────────────────────────────────────────

function headingDepth(row: Row, fontStyleMap?: Record<string, FontStyle>): number | null {
  const maxSz = Math.max(...row.map(t => t.fontSize));
  const text = rowText(row);
  if (ALL_CAPS_RE.test(text) && text.length > 3) return null;
  if (text.endsWith(':')) return null;
  if (text.length > 80) return null;
  if (maxSz >= 20) return 1;
  if (maxSz >= 16) return 2;
  if (maxSz >= 14) return 3;
  if (maxSz >= 12.5) return 4;
  if (maxSz >= 11.5) return 5;
  if (maxSz >= 10 && row.some(t => fontStyleMap?.[t.fontName]?.strong)) return 6;
  return null;
}

// ── Inline formatting ──────────────────────────────────────────────────

/**
 * Convert a single mdast phrasing node to its HTML string representation.
 * Used to preserve inner formatting (bold, italic, inline code) when wrapping
 * with decoration tags (underline, overline).
 */
function phrasingToHtml(node: PhrasingContent): string {
  if (node.type === 'text') return escapeHtml((node as MdText).value);
  if (node.type === 'inlineCode') return '<code>' + escapeHtml((node as any).value) + '</code>';
  if (node.type === 'strong') return '<strong>' + ((node as any).children as PhrasingContent[]).map(phrasingToHtml).join('') + '</strong>';
  if (node.type === 'emphasis') return '<em>' + ((node as any).children as PhrasingContent[]).map(phrasingToHtml).join('') + '</em>';
  if (node.type === 'delete') return '<del>' + ((node as any).children as PhrasingContent[]).map(phrasingToHtml).join('') + '</del>';
  // Fallback: return plain text value
  return String((node as any).value ?? '');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Apply decorations (underline, overline, strikethrough) to a single node.
 * Decorations are detected from either PDF annotations or graphic lines
 * in the page's operator list.
 *
 * Underline and overline use raw HTML nodes (no native markdown syntax exists).
 * Strikethrough uses the delete node type (maps to ~~text~~ in GFM).
 */
function applyItemDecoration(
  node: PhrasingContent,
  t: TxtItem,
): PhrasingContent {
  // Underline: wrap in <u> HTML, preserving inner formatting
  if (t.underline) {
    node = { type: 'html', value: `<u>${phrasingToHtml(node)}</u>` } as any;
  }
  // Overline: wrap in <span> HTML, preserving inner formatting
  if (t.overline) {
    node = { type: 'html', value: `<span style="text-decoration: overline">${phrasingToHtml(node)}</span>` } as any;
  }
  // Strikethrough: wrap in delete mdast node (serializes to ~~text~~)
  if (t.strikethrough) {
    node = { type: 'delete', children: [node] } as any;
  }
  return node;
}

function buildPhrasing(row: Row, fontStyleMap?: Record<string, FontStyle>): PhrasingContent[] {
  if (!row.length) return [];
  const counts: Record<string, number> = {};
  for (const t of row) counts[t.fontName] = (counts[t.fontName] || 0) + 1;
  let maxCount = 0, rowBodyFont = row[0].fontName;
  for (const [fn, c] of Object.entries(counts)) { if (c > maxCount) { maxCount = c; rowBodyFont = fn; } }

  const out: PhrasingContent[] = [];
  for (let i = 0; i < row.length; i++) {
    const t = row[i];
    let node: PhrasingContent = { type: 'text', value: t.str } as MdText;
    if (t.isMono) {
      node = { type: 'inlineCode', value: t.str };
    } else if (t.fontName !== rowBodyFont) {
      const fs = fontStyleMap?.[t.fontName];
      if (fs?.em && fs?.strong) {
        node = { type: 'strong', children: [{ type: 'emphasis', children: [node] }] };
      } else if (fs?.em) {
        node = { type: 'emphasis', children: [node] };
      } else {
        node = { type: 'strong', children: [node] };
      }
    }
    // Apply annotation-based decorations (underline, strikethrough)
    node = applyItemDecoration(node, t);
    if (i > 0 && out.length) out.push({ type: 'text', value: ' ' } as MdText);
    out.push(node);
  }
  return out;
}

// ── Strikethrough ──────────────────────────────────────────────────────

function applyStrikethrough(nodes: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      const parts = node.value.split(/(~~.+?~~)/g);
      for (const part of parts) {
        if (part.startsWith('~~') && part.endsWith('~~') && part.length > 4) {
          out.push({ type: 'delete', children: [{ type: 'text', value: part.slice(2, -2) }] });
        } else if (part) out.push({ type: 'text', value: part });
      }
    } else out.push(node);
  }
  return out;
}

// ── Decoration detection from page operators (graphic lines) ─────────

/**
 * Detect underline, overline, and strikethrough by analyzing the page's
 * drawing operators for horizontal lines positioned near text baselines.
 *
 * This handles PDFs where text decorations are rendered as graphic paths
 * (e.g., PDFs from Word, Google Docs) rather than as PDF annotations.
 */
async function detectTextDecorationsFromOperators(
  page: any,
  items: TxtItem[],
): Promise<void> {
  if (!items.length) return;

  // Skip expensive operator parsing if all items already have decorations
  const needsDecoration = items.some(t => !t.underline && !t.overline && !t.strikethrough);
  if (!needsDecoration) return;

  // getOperatorList can be slow on some PDFs; use a timeout
  const opList = await Promise.race([
    page.getOperatorList(),
    new Promise<null>((_, reject) =>
      setTimeout(() => reject(new Error('getOperatorList timed out')), 10000),
    ),
  ]).catch(() => null);

  if (!opList || !opList.fnArray || !opList.fnArray.length) return;

  // Use the actual page width for filtering full-width lines
  const viewport = page.getViewport({ scale: 1 });
  const pageWidth = viewport.width;

  // Parse operators to find executed horizontal lines
  // pdfjs v5.x compiles PDF path operators into constructPath (OPS.constructPath=91)
  // or individual operators (moveTo=13, lineTo=14, rectangle=19, etc.)
  const { OPS } = await getPdfJs();
  const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
  let path: { x: number; y: number }[] = [];

  /** Extract horizontal line segments from a subpath object inside constructPath */
  function extractLinesFromSubpath(subpath: Record<string, number>): void {
    const keys = Object.keys(subpath).map(Number).sort((a, b) => a - b);
    let cur: { x: number; y: number } | null = null;
    let k = 0;
    while (k < keys.length) {
      const flag = subpath[keys[k]];
      if (flag === 0 || flag === 1) {
        // moveTo (0) or lineTo (1) — both have (flag, x, y) triplets
        const x = subpath[keys[k + 1]];
        const y = subpath[keys[k + 2]];
        if (flag === 0) {
          cur = { x, y };
        } else if (cur !== null && Math.abs(y - cur.y) < 2 && Math.abs(x - cur.x) > 20) {
          lines.push({ x1: cur.x, y1: cur.y, x2: x, y2: y });
          cur = { x, y };
        } else if (flag === 1) {
          cur = { x, y };
        }
        k += 3;
      } else {
        // closePath (4) or other flags — single entry
        if (flag === 4) cur = null;
        k++;
      }
    }
  }

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn: number = opList.fnArray[i];
    const args: any = opList.argsArray[i];

    if (fn === OPS.constructPath) {
      // constructPath bundles path ops: args = [drawingOp, subpaths[], bbox]
      if (Array.isArray(args[1])) {
        for (const subpath of args[1]) {
          if (subpath && typeof subpath === 'object') {
            extractLinesFromSubpath(subpath);
          }
        }
      }
    } else if (fn === OPS.moveTo) {
      path = [{ x: args[0], y: args[1] }];
    } else if (fn === OPS.lineTo && path.length > 0) {
      const prev = path[path.length - 1];
      const x2 = args[0], y2 = args[1];
      if (Math.abs(y2 - prev.y) < 2 && Math.abs(x2 - prev.x) > 20) {
        lines.push({ x1: prev.x, y1: prev.y, x2, y2 });
      }
      path.push({ x: x2, y: y2 });
    } else if (fn === OPS.rectangle) {
      const [rx, ry, rw, rh] = args;
      if (rh < 3 && rw > 20) {
        lines.push({ x1: rx, y1: ry, x2: rx + rw, y2: ry + rh });
      }
      path = [];
    } else if (fn === OPS.closePath || fn === OPS.endPath) {
      path = [];
    } else if (fn === OPS.stroke || fn === OPS.closeStroke || fn === OPS.fillStroke || fn === OPS.fill) {
      path = [];
    }
  }

  if (!lines.length) return;

  // Filter out lines that span most of the page width (table borders, <hr>)
  const maxPageSpan = pageWidth * 0.85;
  const filteredLines = lines.filter(l => (l.x2 - l.x1) < maxPageSpan);
  if (!filteredLines.length) return;

  // Match each line to nearby text items
  for (const item of items) {
    if (item.underline || item.overline || item.strikethrough) continue;
    if (!item.str.trim()) continue;

    const fs = item.fontSize;

    for (const line of filteredLines) {
      // Line must overlap horizontally with the text (with tolerance)
      if (line.x1 > item.x + item.width + 15 || line.x2 < item.x - 15) continue;

      const lineY = (line.y1 + line.y2) / 2;
      const relY = lineY - item.y; // position relative to text baseline

      if (relY >= fs * 0.75 && relY < fs + 6) {
        // Overline: line above the text's ascender region
        item.overline = true;
        break;
      } else if (relY >= fs * 0.1 && relY < fs * 0.85) {
        // Strikethrough: line through the middle of the text
        item.strikethrough = true;
        break;
      } else if (relY >= -6 && relY < fs * 0.1) {
        // Underline: line at or just below the baseline
        item.underline = true;
        break;
      }
    }
  }
}

// ── Decoration detection from annotations ─────────────────────────────

function applyDecorationFlags(items: TxtItem[], rects: number[][], key: 'underline' | 'strikethrough'): void {
  if (!rects.length) return;
  for (const item of items) {
    if (item[key]) continue;
    for (const rect of rects) {
      const [rx1, ry1, rx2, ry2] = rect;
      if (
        item.x >= rx1 - 2 &&
        item.x + item.width <= rx2 + 2 &&
        item.y >= ry1 - 2 &&
        item.y + item.fontSize <= ry2 + 2
      ) {
        item[key] = true;
        break;
      }
    }
  }
}

// ── Link detection from annotations ────────────────────────────────────

function applyLinks(
  nodes: PhrasingContent[], row: Row,
  linkRects: { url: string; rect: number[] }[],
): PhrasingContent[] {
  if (!linkRects.length) return nodes;
  const rowY = row[0].y;
  const rowEndY = rowY + Math.max(...row.map(t => t.fontSize));
  for (const lr of linkRects) {
    const [rx1, ry1, rx2, ry2] = lr.rect;
    const overlap = row.some(t => t.x >= rx1 - 2 && t.x <= rx2 + 2 && rowY >= ry1 - 2 && rowEndY <= ry2 + 2);
    if (!overlap) continue;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type !== 'text') continue;
      const tv = (n as MdText).value;
      if (URL_RE.test(tv)) {
        nodes[i] = { type: 'link', url: lr.url, title: null, children: [{ type: 'text', value: tv }] } as any;
      }
    }
  }
  return nodes;
}

// ── Table detection ────────────────────────────────────────────────────

function detectColumns(rows: Row[]): { isTable: boolean; columns: number[] } {
  if (rows.length < 2) return { isTable: false, columns: [] };
  const colXss = rows.map(r => r.map(t => t.x).sort((a, b) => a - b));
  const counts = colXss.map(xs => xs.length);
  const modeCount = mode(counts);
  if (modeCount < 2) return { isTable: false, columns: [] };
  const valid = colXss.filter(xs => xs.length === modeCount);
  if (valid.length < 2) return { isTable: false, columns: [] };
  const first = valid[0];
  const cols: number[] = [];
  for (let c = 0; c < first.length; c++) {
    const pos = valid.map(r => r[c]);
    const avg = pos.reduce((a, b) => a + b, 0) / pos.length;
    const var_ = pos.reduce((a, b) => a + (b - avg) ** 2, 0) / pos.length;
    if (var_ > 50) return { isTable: false, columns: [] };
    cols.push(Math.round(avg));
  }
  return { isTable: true, columns: cols };
}

// ── Nested list builder ────────────────────────────────────────────────

type ListItemData = { text: string; x: number; phrasing: PhrasingContent[] };

function buildNestedList(items: ListItemData[], ordered = false): List {
  function build(data: ListItemData[]): List {
    const children: ListItem[] = [];
    let idx = 0;
    while (idx < data.length) {
      const item = data[idx];
      const itemChildren: Content[] = [...item.phrasing];
      const nested: ListItemData[] = [];
      let ni = idx + 1;
      while (ni < data.length && data[ni].x > item.x + 5) {
        nested.push(data[ni]);
        ni++;
      }
      if (nested.length > 0) { itemChildren.push(buildNestedList(nested, ordered)); idx = ni; }
      else idx++;
      children.push({ type: 'listItem', children: itemChildren } as ListItem);
    }
    return { type: 'list', ordered, children } as List;
  }
  return build(items);
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN CONVERTER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Convert PDF data to Markdown string.
 *
 * @param data - The PDF file data (ArrayBuffer or Uint8Array)
 * @param options - Optional configuration
 * @returns The converted Markdown string
 *
 * @example
 * ```ts
 * // Browser: from a File
 * const md = await pdfToMarkdown(await file.arrayBuffer());
 *
 * // Node.js: from a buffer
 * import { readFileSync } from 'fs';
 * const md = await pdfToMarkdown(readFileSync('document.pdf').buffer);
 * ```
 */
export async function pdfToMarkdown(
  data: ArrayBuffer | Uint8Array,
  options?: PdfToMarkdownOptions,
): Promise<string> {
  const { getDocument, GlobalWorkerOptions } = await getPdfJs();

  // Handle environment-specific worker configuration
  const isNode =
    typeof process !== 'undefined' &&
    process?.versions?.node != null;

  if (!isNode && typeof self !== 'undefined') {
    // Browser: configure worker
    try {
      // User can also configure this externally if needed
      if (!GlobalWorkerOptions.workerSrc) {
        GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url,
        ).toString();
      }
    } catch {
      // Fallback: worker may already be configured
    }
  }

  // Always create a plain Uint8Array — pdfjs rejects Buffer (Node.js)
  const pdfData = new Uint8Array(
    data instanceof ArrayBuffer ? data : (data as Uint8Array),
  );
  const pdf = await getDocument({ data: pdfData }).promise;
  const children: Content[] = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    if (options?.signal?.aborted) throw new DOMException('Conversion cancelled', 'AbortError');

    const page = await pdf.getPage(p);
    const tc = await page.getTextContent({ includeMarkedContent: false });
    const styles = (tc.styles ?? {}) as Record<string, { fontFamily?: string }>;
    const annots = await page.getAnnotations();

    // Link rects from annotations
    const linkRects: { url: string; rect: number[] }[] = [];
    // Decoration rects from annotations
    const underlineRects: number[][] = [];
    const strikethroughRects: number[][] = [];
    for (const a of annots) {
      if (a.subtype === 'Link' && (a as any).url && Array.isArray((a as any).rect))
        linkRects.push({ url: (a as any).url as string, rect: (a as any).rect as number[] });
      if (a.subtype === 'Underline' && Array.isArray((a as any).rect))
        underlineRects.push((a as any).rect as number[]);
      if (a.subtype === 'StrikeOut' && Array.isArray((a as any).rect))
        strikethroughRects.push((a as any).rect as number[]);
    }

    // Extract items
    const items: TxtItem[] = tc.items
      .map((item: any) => {
        const str = String(item.str ?? '').trim();
        if (!str) return null;
        const fn = item.fontName ?? '';
        const s = styles[fn];
        const fs = Math.sqrt((item.transform?.[0] ?? 0) ** 2 + (item.transform?.[1] ?? 0) ** 2);
        return {
          str, x: item.transform?.[4] ?? 0, y: item.transform?.[5] ?? 0,
          fontName: fn, fontSize: fs, width: item.width ?? 0,
          isMono: s?.fontFamily === 'monospace',
          underline: false, overline: false, strikethrough: false,
        } as TxtItem;
      })
      .filter(Boolean) as TxtItem[];

    if (!items.length) continue;

    // Apply decoration flags from annotations (underline, strikethrough)
    applyDecorationFlags(items, underlineRects, 'underline');
    applyDecorationFlags(items, strikethroughRects, 'strikethrough');

    // Also detect decorations from page operators (graphic lines near text)
    // This handles PDFs without annotations (e.g., from Word, Google Docs)
    await detectTextDecorationsFromOperators(page, items);

    const rows = groupRows(items);
    const fontStyleMap = buildFontStyleMap(items);
    const bm = bodyMargin(rows);
    let i = 0;

    while (i < rows.length) {
      if (options?.signal?.aborted) throw new DOMException('Conversion cancelled', 'AbortError');

      const row = rows[i];
      const text = rowText(row);
      if (!text) { i++; continue; }
      const hd = headingDepth(row, fontStyleMap);

      // 1. Code block
      if (row.every(t => t.isMono) && i + 1 < rows.length) {
        let j = i + 1;
        while (j < rows.length && rows[j].length > 0 && rows[j].every(t => t.isMono)) j++;
        if (j - i >= 2) {
          children.push({
            type: 'code', lang: null, meta: null,
            value: rows.slice(i, j).map(r => rowText(r)).join('\n'),
          } as Code);
          i = j; continue;
        }
      }

      // 2. Heading
      if (hd !== null) {
        let phr = buildPhrasing(row, fontStyleMap);
        phr = applyLinks(phr, row, linkRects);
        children.push({ type: 'heading', depth: hd, children: phr } as Heading);
        i++; continue;
      }

      // 3. Unordered list
      if (BULLET_RE.test(text)) {
        const listItems: ListItemData[] = [];
        let j = i;
        while (j < rows.length) {
          const rt = rowText(rows[j]);
          const m = rt.match(BULLET_RE);
          if (!m) break;
          const contentItems = rows[j].filter(t => !SINGLE_BULLET.test(t.str) && !SINGLE_NUMBER.test(t.str));
          listItems.push({
            text: rt.slice(m[0].length),
            x: Math.round(rows[j][0].x),
            phrasing: contentItems.length ? buildPhrasing(contentItems, fontStyleMap) : [{ type: 'text', value: rt.slice(m[0].length) } as MdText],
          });
          j++;
        }
        if (listItems.length > 0) { children.push(buildNestedList(listItems)); i = j; continue; }
      }

      // 4. Ordered list
      if (ORDERED_RE.test(text)) {
        const listItems: ListItemData[] = [];
        let j = i;
        while (j < rows.length) {
          const rt = rowText(rows[j]);
          const m = rt.match(ORDERED_RE);
          if (!m) break;
          const contentItems = rows[j].filter(t => !SINGLE_NUMBER.test(t.str) && !/^\d+$/.test(t.str));
          listItems.push({
            text: rt.slice(m[0].length),
            x: Math.round(rows[j][0].x),
            phrasing: contentItems.length ? buildPhrasing(contentItems, fontStyleMap) : [{ type: 'text', value: rt.slice(m[0].length) } as MdText],
          });
          j++;
        }
        if (listItems.length > 0) { children.push(buildNestedList(listItems, true)); i = j; continue; }
      }

      // 5. Table
      {
        let j = i + 1;
        while (j < rows.length && rows[j].length >= 2) j++;
        const candidate = rows.slice(i, j);
        if (candidate.length >= 2) {
          const { isTable, columns } = detectColumns(candidate);
          if (isTable && columns.length >= 2) {
            const rawRows: string[][] = [];
            for (const cr of candidate) {
              const cells = new Array(columns.length).fill('');
              for (const t of cr) {
                let bestCol = 0, bestDist = Infinity;
                for (let ci = 0; ci < columns.length; ci++) { const d = Math.abs(t.x - columns[ci]); if (d < bestDist) { bestDist = d; bestCol = ci; } }
                cells[bestCol] = (cells[bestCol] ? cells[bestCol] + ' ' : '') + t.str;
              }
              rawRows.push(cells);
            }
            const modalCount = mode(rawRows.map(r => r.filter(c => c).length));
            const filtered = rawRows.filter(r => r.filter(c => c).length === modalCount);
            if (filtered.length >= 2) {
              children.push({
                type: 'table', align: null,
                children: [
                  { type: 'tableRow', children: filtered[0].map(c => ({ type: 'tableCell' as const, children: [{ type: 'text' as const, value: c }] })) } as TableRow,
                  ...filtered.slice(1).map(r => ({ type: 'tableRow' as const, children: r.map(c => ({ type: 'tableCell' as const, children: [{ type: 'text' as const, value: c }] })) })),
                ],
              } as unknown as Table);
              i = j; continue;
            }
          }
        }
      }

      // 6. Blockquote
      {
        const xMin = Math.min(...row.map(t => t.x));
        if (bm > 0 && xMin > bm + 20 && !BULLET_RE.test(text) && !ORDERED_RE.test(text)) {
          let j = i + 1;
          while (j < rows.length) {
            const rxm = Math.min(...rows[j].map(t => t.x));
            if (rxm <= bm + 20) break;
            j++;
          }
          const bqChildren: Content[] = [];
          for (let k = i; k < j; k++) {
            const br = rows[k];
            const bt = rowText(br);
            if (!bt.trim()) continue;
            const bqHd = headingDepth(br, fontStyleMap);
            if (bqHd !== null) {
              bqChildren.push({ type: 'heading', depth: Math.min(bqHd + 1, 6) as any, children: buildPhrasing(br, fontStyleMap) } as Heading);
            } else if (br.every(t => t.isMono)) {
              bqChildren.push({ type: 'code', lang: null, meta: null, value: bt } as Code);
            } else {
              const contentItems = br.filter(t => !SINGLE_BULLET.test(t.str) && !SINGLE_NUMBER.test(t.str));
              let phr = contentItems.length ? buildPhrasing(contentItems, fontStyleMap) : [{ type: 'text', value: bt } as MdText];
              phr = applyStrikethrough(phr);
              bqChildren.push({ type: 'paragraph', children: phr } as Paragraph);
            }
          }
          children.push({ type: 'blockquote', children: bqChildren } as Blockquote);
          i = j; continue;
        }
      }

      // 7. Paragraph (merge consecutive non-special rows)
      {
        let j = i + 1;
        while (j < rows.length) {
          const nt = rowText(rows[j]);
          if (!nt.trim()) { j++; continue; }
          if (headingDepth(rows[j], fontStyleMap) !== null) break;
          if (BULLET_RE.test(nt)) break;
          if (ORDERED_RE.test(nt)) break;
          if (rows[j].every(t => t.isMono)) break;
          const yGap = Math.abs(rows[j][0].y - rows[i][rows[i].length - 1].y);
          if (yGap > 20) break;
          j++;
        }
        const merged: PhrasingContent[] = [];
        for (let k = i; k < j; k++) {
          const rt = rowText(rows[k]);
          if (!rt.trim()) continue;
          if (k > i && merged.length) merged.push({ type: 'text', value: ' ' } as MdText);
          let phr = buildPhrasing(rows[k], fontStyleMap);
          phr = applyStrikethrough(phr);
          phr = applyLinks(phr, rows[k], linkRects);
          merged.push(...phr);
        }
        if (merged.length) children.push({ type: 'paragraph', children: merged } as Paragraph);
        i = j;
      }
    }
  }

  return toMarkdown({ type: 'root', children } as Root, {
    extensions: [gfmToMarkdown()],
    bullet: '-',
  });
}
