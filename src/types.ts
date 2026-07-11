/** A single text item extracted from a PDF page */
export type TxtItem = {
  str: string;
  x: number;
  y: number;
  fontName: string;
  fontSize: number;
  width: number;
  isMono: boolean;
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
