import type { Request, Response, Router } from 'express';
import type { AgentConnectionInterface } from '../contracts/agentConnection.js';
import type { ConnectionConfig, WireRuntimeInstructionPayload } from '../types/wireProtocol.js';
import { RuntimeInstruction } from '../types/instructions.js';
import { SignatureError } from '../exceptions/SignatureError.js';
import { ReplayError } from '../exceptions/ReplayError.js';
import { handleExtractionRequest } from './extractionController.js';
import { logger } from '../logger.js';

/**
 * Receives signed envelopes pushed by the SaaS.
 *
 * POST {webhook_path}
 *
 * Supported message_types:
 *   runtime_instruction  → cache and ack immediately
 *   extraction_request   → run AST extraction and POST results back to SaaS
 *
 * Any HMAC/replay verification failure returns generic 400 — no oracle detail.
 */
export function registerWebhookRoute(
  router: Router,
  connection: AgentConnectionInterface,
  config: ConnectionConfig,
  webhookPath: string,
  enabled: boolean,
): void {
  if (!enabled) return;

  router.post(webhookPath, async (req: Request, res: Response): Promise<void> => {
    const raw: unknown = req.body;

    let envelope: Awaited<ReturnType<AgentConnectionInterface['verifyEnvelope']>>;

    try {
      envelope = await connection.verifyEnvelope(raw);
    } catch (err) {
      if (err instanceof SignatureError || err instanceof ReplayError) {
        logger.warn('RemediationEngine: webhook verification failed.', {
          error: err.message,
          name:  err.name,
        });
        res.status(400).json({ error: 'Bad request.' });
        return;
      }

      logger.error('RemediationEngine: webhook error.', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal error.' });
      return;
    }

    const messageType = String((envelope as Record<string, unknown>)['message_type'] ?? '');

    try {
      if (messageType === 'runtime_instruction') {
        const instruction = RuntimeInstruction.fromWirePayload(
          envelope.payload as WireRuntimeInstructionPayload,
        );
        await connection.cacheInstruction(instruction);
        await connection.acknowledgeInstruction(instruction.instructionId);
        res.status(200).json({ status: 'accepted' });
        return;
      }

      if (messageType === 'extraction_request') {
        // Respond immediately — extraction runs async so the SaaS webhook
        // call does not time out waiting for the AST pass to complete.
        res.status(202).json({ status: 'queued' });

        void handleExtractionRequest(
          envelope.payload as Record<string, unknown>,
          config,
        ).catch((err: unknown) => {
          logger.error('RemediationEngine: extraction failed.', {
            error: err instanceof Error ? err.message : String(err),
          });
        });

        return;
      }

      res.status(400).json({ error: 'Unknown message_type.' });
    } catch (err) {
      logger.error('RemediationEngine: webhook processing error.', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal error.' });
    }
  });
}
