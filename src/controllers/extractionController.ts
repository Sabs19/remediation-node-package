import type { Request, Response, Router } from 'express';
import axios from 'axios';
import * as path from 'path';
import { AstExtractorService } from '../services/AstExtractorService.js';
import { parseExtractionRequestPayload, type ExtractionResult } from '../types/extraction.js';
import type { ConnectionConfig } from '../types/wireProtocol.js';
import { logger } from '../logger.js';

/**
 * Handles extraction_request envelopes dispatched from the SaaS.
 *
 * Runs AST extraction for each target synchronously within the webhook
 * handler (Express async), then POSTs the results back to the SaaS callback URL.
 *
 * For large extraction jobs, this can be deferred to a worker thread or
 * a background queue — the callback pattern means the SaaS is not blocked.
 */
export async function handleExtractionRequest(
  payload: Record<string, unknown>,
  config: ConnectionConfig,
): Promise<void> {
  const request = parseExtractionRequestPayload(payload);

  const extractor = new AstExtractorService();
  const results: ExtractionResult[] = [];

  for (const target of request.targets) {
    // Resolve relative file paths from the process working directory.
    const absolutePath = path.resolve(process.cwd(), target.filePath);
    const result = extractor.extract(absolutePath, target);

    if (result === null) {
      logger.warn('AstExtractor: symbol not found.', {
        file:   target.filePath,
        symbol: target.symbolName,
      });
      continue;
    }

    results.push(result);
  }

  if (results.length === 0) {
    logger.error('ProcessExtraction: no results extracted.', {
      extraction_id: request.extraction_id,
    });
    return;
  }

  const callbackUrl = config.saasUrl.replace(/\/$/, '') + request.callback_url;

  await axios.post(
    callbackUrl,
    { results },
    {
      headers: {
        'X-Remediation-Client-Id': config.clientId,
        'X-Remediation-Token':     config.token,
        'Content-Type':            'application/json',
      },
      timeout: 30_000,
    },
  );

  logger.info('Extraction results posted to SaaS.', {
    extraction_id: request.extraction_id,
    count:         results.length,
  });
}
