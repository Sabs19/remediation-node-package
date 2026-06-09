import * as fs from 'fs';
import * as path from 'path';
import type { ExtractionResult, ExtractionTarget } from '../types/extraction.js';
import { logger } from '../logger.js';

/**
 * AST-based extractor for TypeScript/JavaScript source files.
 *
 * Uses the TypeScript compiler API (the same `typescript` package that's
 * already present in any TS project) to locate and extract symbol source.
 * Falls back to a regex-based line scanner when the TS compiler is not
 * available (plain JS projects or environments without `typescript`).
 */
export class AstExtractorService {
  extract(absoluteFilePath: string, target: ExtractionTarget): ExtractionResult | null {
    if (!fs.existsSync(absoluteFilePath)) {
      logger.warn('AstExtractor: file not found.', { filePath: absoluteFilePath });
      return null;
    }

    try {
      return this.extractWithTs(absoluteFilePath, target);
    } catch (err) {
      logger.warn('AstExtractor: TS compiler unavailable, falling back to line scanner.', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.extractWithLineScan(absoluteFilePath, target);
    }
  }

  // ---------------------------------------------------------------------------
  // TypeScript Compiler API extraction
  // ---------------------------------------------------------------------------

  private extractWithTs(filePath: string, target: ExtractionTarget): ExtractionResult | null {
    // Dynamic require — typescript is a peer/devDep, not a runtime dep.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ts = require('typescript') as typeof import('typescript');

    const sourceText = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
    );

    const lines = sourceText.split('\n');

    const found = this.findNode(ts, sourceFile, target);
    if (!found) return null;

    const { node, startLine, endLine } = found;

    const sourceCode = lines.slice(startLine - 1, endLine).join('\n');
    const docBlock   = this.extractDocBlock(sourceText, node, ts, sourceFile);

    return {
      filePath,
      startLine,
      endLine,
      sourceCode,
      symbolName: target.symbolName,
      symbolType: target.symbolType,
      docBlock,
    };
  }

  private findNode(
    ts: typeof import('typescript'),
    sourceFile: import('typescript').SourceFile,
    target: ExtractionTarget,
  ): { node: import('typescript').Node; startLine: number; endLine: number } | null {
    let result: { node: import('typescript').Node; startLine: number; endLine: number } | null = null;

    const visit = (node: import('typescript').Node): void => {
      if (result) return;

      if (target.symbolType === 'function' || target.symbolType === 'method') {
        if (
          (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) &&
          ts.isIdentifier((node as import('typescript').FunctionDeclaration).name ?? ({} as import('typescript').Node)) &&
          ((node as import('typescript').FunctionDeclaration).name as import('typescript').Identifier).text === target.symbolName
        ) {
          result = this.nodePosition(ts, sourceFile, node);
          return;
        }
      }

      if (target.symbolType === 'class') {
        if (
          ts.isClassDeclaration(node) &&
          node.name?.text === target.symbolName
        ) {
          result = this.nodePosition(ts, sourceFile, node);
          return;
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
    return result;
  }

  private nodePosition(
    ts: typeof import('typescript'),
    sourceFile: import('typescript').SourceFile,
    node: import('typescript').Node,
  ): { node: import('typescript').Node; startLine: number; endLine: number } {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const end   = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    return {
      node,
      startLine: start.line + 1,
      endLine:   end.line + 1,
    };
  }

  private extractDocBlock(
    sourceText: string,
    node: import('typescript').Node,
    ts: typeof import('typescript'),
    sourceFile: import('typescript').SourceFile,
  ): string | null {
    const nodeStart = node.getFullStart();
    const preceding = sourceText.slice(Math.max(0, nodeStart - 500), nodeStart);
    const match = preceding.match(/\/\*\*[\s\S]*?\*\/\s*$/);
    return match ? match[0].trim() : null;
  }

  // ---------------------------------------------------------------------------
  // Fallback: line scanner (regex-based, no AST)
  // ---------------------------------------------------------------------------

  private extractWithLineScan(filePath: string, target: ExtractionTarget): ExtractionResult | null {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');

    // Find the first line matching the symbol name.
    const startIdx = lines.findIndex(
      (line) => line.includes(target.symbolName) &&
                (line.includes('function') || line.includes('class') || line.includes('=>') || line.includes('(')),
    );

    if (startIdx === -1) return null;

    // Walk forward to find the closing brace using a simple depth counter.
    let depth = 0;
    let endIdx = startIdx;

    for (let i = startIdx; i < lines.length; i++) {
      for (const ch of lines[i] ?? '') {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      endIdx = i;
      if (depth === 0 && i > startIdx) break;
    }

    const sourceCode = lines.slice(startIdx, endIdx + 1).join('\n');

    return {
      filePath,
      startLine:  startIdx + 1,
      endLine:    endIdx + 1,
      sourceCode,
      symbolName: target.symbolName,
      symbolType: target.symbolType,
      docBlock:   null,
    };
  }
}
