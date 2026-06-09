export type SymbolType = 'method' | 'function' | 'class' | 'route';

export interface ExtractionTarget {
  readonly filePath: string;
  readonly symbolName: string;
  readonly symbolType: SymbolType;
}

export interface ExtractionResult {
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly sourceCode: string;
  readonly symbolName: string;
  readonly symbolType: SymbolType;
  readonly docBlock: string | null;
}

export interface ExtractionRequestPayload {
  readonly extraction_id: string;
  readonly extraction_type: string;
  readonly targets: readonly ExtractionTarget[];
  readonly callback_url: string;
  readonly include_ast: boolean;
  readonly include_docblock: boolean;
  readonly include_line_numbers: boolean;
  readonly max_lines_per_symbol: number;
}

export function parseExtractionRequestPayload(payload: Record<string, unknown>): ExtractionRequestPayload {
  return {
    extraction_id:        String(payload['extraction_id']        ?? ''),
    extraction_type:      String(payload['extraction_type']      ?? 'generic'),
    targets:              (Array.isArray(payload['targets']) ? payload['targets'] : []) as ExtractionTarget[],
    callback_url:         String(payload['callback_url']         ?? ''),
    include_ast:          Boolean(payload['include_ast']         ?? true),
    include_docblock:     Boolean(payload['include_docblock']    ?? true),
    include_line_numbers: Boolean(payload['include_line_numbers'] ?? true),
    max_lines_per_symbol: Number(payload['max_lines_per_symbol'] ?? 500),
  };
}
