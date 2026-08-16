// Minimal ambient types for `word-extractor` (no upstream/@types package
// shipped as of the pinned version — see documents.ts's .doc extraction
// path). Only the shape this codebase actually calls is declared.
declare module 'word-extractor' {
  export default class WordExtractor {
    constructor();
    extract(source: string | Buffer): Promise<WordExtractorDocument>;
  }

  export interface WordExtractorDocument {
    getBody(): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getHeaders(options?: { includeFooters?: boolean }): string;
    getFooters(): string;
    getAnnotations(): string;
    getTextboxes(options?: { includeHeadersAndFooters?: boolean }): string;
  }
}
