/** A single text item extracted from a PDF page */
export type TxtItem = {
  str: string;
  x: number;
  y: number;
  fontName: string;
  fontSize: number;
  width: number;
  isMono: boolean;
  /** Whether the text has underline decoration (detected via Underline annotations or graphic lines) */
  underline: boolean;
  /** Whether the text has overline decoration (detected via graphic lines above text) */
  overline: boolean;
  /** Whether the text has strikethrough decoration (detected via StrikeOut annotations or graphic lines) */
  strikethrough: boolean;
};

/** A row of text items grouped by Y-position */
export type Row = TxtItem[];

/** Inline formatting for a font (detected via width-per-character analysis) */
export type FontStyle = {
  strong: boolean;
  em: boolean;
};

/** Options for the PDF to Markdown conversion */
export type PdfToMarkdownOptions = {
  /** Whether to allow cancellation via abort signal */
  signal?: AbortSignal;
};
