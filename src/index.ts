/**
 * node-pdf-to-md - Convert PDF documents to Markdown
 *
 * Works in both browser and Node.js environments.
 * Uses pdf.js for PDF parsing and mdast for Markdown serialization.
 *
 * @module node-pdf-to-md
 */

export { pdfToMarkdown } from './converter.js';
export type { TxtItem, Row, FontStyle, PdfToMarkdownOptions } from './types.js';
