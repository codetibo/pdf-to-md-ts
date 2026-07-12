# pdf-to-md-ts

> Convert PDF documents to clean Markdown — works in **browser** and **Node.js**.

A fast, dependency-light PDF-to-Markdown converter powered by Mozilla's pdf.js. No external APIs, no server calls — everything runs locally.

---

## Installation

```bash
npm install pdf-to-md-ts
```

## Quick Start

### Browser

```ts
import { pdfToMarkdown } from 'pdf-to-md-ts';

// From a file input
const fileInput = document.querySelector('input[type="file"]');
const file = fileInput!.files![0];
const data = await file.arrayBuffer();

const markdown = await pdfToMarkdown(data);
console.log(markdown);
```

### Node.js

```ts
import { pdfToMarkdown } from 'pdf-to-md-ts';
import { readFile } from 'node:fs/promises';

const data = await readFile('document.pdf');
const markdown = await pdfToMarkdown(data.buffer);

console.log(markdown);
```

## API

### `pdfToMarkdown(data, options?)`

Converts PDF data to a Markdown string.

#### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `data` | `ArrayBuffer \| Uint8Array` | The PDF file contents |
| `options.signal` | `AbortSignal` | Optional `AbortSignal` to cancel conversion |

#### Returns

`Promise<string>` — The converted Markdown text.

#### Errors

Throws on invalid PDF data. Throws `AbortError` (or `Error` in older Node.js) when cancelled via `AbortSignal`.

### Types

```ts
import type { PdfToMarkdownOptions, TxtItem, Row, FontStyle } from 'pdf-to-md-ts';
```

---

## Features

| Feature | Description |
|---------|-------------|
| **H1–H6** | Heading detection by font size with bold verification |
| **Bold** | `**text**` via glyph width analysis (>3% wider than body) |
| **Italic** | `*text*` via glyph width analysis (>15% narrower than body) |
| **Bold+Italic** | `***text***` (mixed formatting detected automatically) |
| **Lists** | Ordered (`1.`) and unordered (`-`) with X-position nesting |
| **Tables** | GFM pipe tables via column alignment analysis |
| **Blockquotes** | `> ` indented text blocks with mixed content support |
| **Code Blocks** | Fenced ` ``` ` blocks for monospaced text regions |
| **Inline Code** | `` `code` `` for monospaced inline text |
| **Underline** | `<u>text</u>` via PDF annotations and graphic line detection |
| **Overline** | `<span style="text-decoration: overline">text</span>` via graphic line detection |
| **Strikethrough** | `~~text~~` via PDF annotations and graphic line detection |
| **Hyperlinks** | Detected from PDF link annotations |
| **Cancellable** | Pass an `AbortSignal` to cancel long conversions |

---

## How It Works

```
PDF bytes → pdf.js text extraction → Layout analysis → mdast AST → Markdown string
```

1. **Text Extraction** — pdf.js parses the PDF and extracts every text glyph with position, font name, font size, and glyph width.

2. **Layout Analysis** — Glyphs are grouped into rows by Y-position, then processed through a detection pipeline:
   - Code blocks → monospaced font runs
   - Headings → font-size thresholds + bold verification
   - Lists → bullet/number patterns with indentation nesting
   - Tables → column position alignment
   - Blockquotes → X-position indentation
   - Paragraphs → merged consecutive non-special rows

3. **Decoration Detection** — Horizontal graphic lines near text are analyzed to detect text decorations:
   - Lines above the text → **overline**
   - Lines through the middle → **strikethrough**
   - Lines below the baseline → **underline**
   - PDF annotations (Underline, StrikeOut) are also parsed for decoration detection

4. **Inline Formatting** — A statistical **width-per-character (WPC)** analysis compares glyph widths across fonts:
   - Body text (most common font) → plain
   - Wider glyphs (>3%) → **bold**
   - Narrower glyphs (>15%) → *italic*
   - Between both → ***bold+italic***

5. **Serialization** — The resulting mdast tree is serialized to GFM-compatible Markdown.

---

## Environment Support

| Environment | Status | Notes |
|-------------|--------|-------|
| Browser (ESM) | ✅ | pdf.js worker configured automatically |
| Node.js 18+ | ✅ | Uses pdf.js legacy build (built-in worker) |
| Node.js 16 | ✅ | Requires `--experimental-fetch` flag |
| Deno | ⚠️ | Requires polyfill for `document.createElement` |
| Bun | ⚠️ | Requires canvas polyfill for worker |

---

## Limitations

- **Embedded images** are not extracted — only text content is converted.
- **Scanned/image PDFs** require OCR (not included).
- **Complex layouts** (multi-column, rotated text, custom fonts) may produce suboptimal results.
- **H6 headings** (10pt) are detected only when using a bold font — table cells at the same size are correctly excluded.

---

## License

MIT
