/**
 * Core PDF to Markdown converter.
 * Extracts text from PDF via pdf.js, analyzes layout, and produces Markdown.
 * Works in both browser and Node.js environments.
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
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
  // Handle environment-specific worker configuration
  const isNode =
    typeof process !== 'undefined' &&
    process.versions != null &&
    process.versions.node != null;

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

  const pdfData = data instanceof Uint8Array ? data : new Uint8Array(data);
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
    for (const a of annots) {
      if (a.subtype === 'Link' && (a as any).url && Array.isArray((a as any).rect))
        linkRects.push({ url: (a as any).url as string, rect: (a as any).rect as number[] });
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
        } as TxtItem;
      })
      .filter(Boolean) as TxtItem[];

    if (!items.length) continue;

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
