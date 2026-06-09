/**
 * Develler — Node.js/Express Agent
 *
 * Public API. Import and call createRemediationMiddleware() in your Express app:
 *
 *   import { createRemediationMiddleware } from 'develler-remediation-agent';
 *
 *   const remediation = await createRemediationMiddleware();
 *   app.use(remediation.handler());
 *
 *   // Optional: mount the webhook receiver so the SaaS can push instructions.
 *   app.use(remediation.webhookRouter());
 */

import Redis from 'ioredis';
import { Router, type RequestHandler } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

import { CircuitBreakerService }    from './services/CircuitBreakerService.js';
import { InstructionCacheService }  from './services/InstructionCacheService.js';
import { MaskingEngine }            from './services/MaskingEngine.js';
import { AgentConnectionService }   from './services/AgentConnectionService.js';
import { RemediationInterceptor }   from './middleware/remediationInterceptor.js';
import { TelemetryReporterService } from './services/TelemetryReporterService.js';
import { registerWebhookRoute }     from './controllers/webhookController.js';
import type { ConnectionConfig }    from './types/wireProtocol.js';

// Re-export public types so consumers don't need deep imports.
export type { ConnectionConfig }                                from './types/wireProtocol.js';
export type { AgentConnectionInterface }                        from './contracts/agentConnection.js';
export type { LifecycleInterceptorInterface }                   from './contracts/lifecycleInterceptor.js';
export { MaskRule, RuntimeInstruction, InstructionCollection }  from './types/instructions.js';
export { SignatureError }                                        from './exceptions/SignatureError.js';
export { ReplayError }                                          from './exceptions/ReplayError.js';
export { MaskingEngine }                                        from './services/MaskingEngine.js';
export { AstExtractorService }                                  from './services/AstExtractorService.js';
export type { ExtractionTarget, ExtractionResult, ExtractionRequestPayload } from './types/extraction.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RemediationConfig {
  /** URL of the Redis instance. Defaults to REDIS_URL env var. */
  readonly redisUrl?:       string;
  /** Connection config object. If omitted, reads .remediation-connection.json. */
  readonly connection?:     ConnectionConfig;
  /** Disable the interceptor entirely (useful for local dev). Default: true. */
  readonly enabled?:        boolean;
  /** Circuit breaker open duration in seconds. Default: 60. */
  readonly cbTtlSeconds?:   number;
  /** Path the SaaS will POST instructions to. Default: /api/remediation/v1/webhook */
  readonly webhookPath?:    string;
  /** Set false to skip registering the webhook route. Default: true. */
  readonly webhookEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Agent handle returned to the caller
// ---------------------------------------------------------------------------

export interface RemediationAgent {
  /** Express RequestHandler — register with app.use(). */
  handler(): RequestHandler;
  /** Express Router with the webhook POST endpoint — register with app.use(). */
  webhookRouter(): Router;
  /** Reset the circuit breaker manually. */
  resetCircuitBreaker(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createRemediationMiddleware(
  cfg: RemediationConfig = {},
): Promise<RemediationAgent> {
  const enabled      = cfg.enabled            ?? (process.env['REMEDIATION_INTERCEPTOR_ENABLED'] !== 'false');
  const cbTtl        = cfg.cbTtlSeconds       ?? parseInt(process.env['REMEDIATION_CB_TTL'] ?? '60', 10);
  const webhookPath  = cfg.webhookPath        ?? (process.env['REMEDIATION_WEBHOOK_PATH'] ?? '/api/remediation/v1/webhook');
  const webhookOn    = cfg.webhookEnabled     ?? (process.env['REMEDIATION_WEBHOOK_ENABLED'] !== 'false');
  const redisUrl     = cfg.redisUrl           ?? (process.env['REDIS_URL'] ?? process.env['REMEDIATION_REDIS_URL'] ?? 'redis://127.0.0.1:6379');
  const connection   = cfg.connection         ?? loadConnectionConfig();

  const redis    = new Redis(redisUrl, { lazyConnect: false, enableOfflineQueue: false });
  const cache    = new InstructionCacheService(redis, connection.client_id);
  const breaker  = new CircuitBreakerService(redis, connection.client_id, cbTtl);
  const masker   = new MaskingEngine();
  const agentConn  = new AgentConnectionService(redis, cache, connection);
  const reporter   = new TelemetryReporterService(connection);
  const interceptor = new RemediationInterceptor(agentConn, masker, breaker, enabled, reporter);

  return {
    handler(): RequestHandler {
      return interceptor.handler();
    },

    webhookRouter(): Router {
      const router = Router();
      router.use(require('express').json());
      registerWebhookRoute(router, agentConn, connection, webhookPath, webhookOn);
      return router;
    },

    async resetCircuitBreaker(): Promise<void> {
      await interceptor.resetCircuitBreaker();
    },
  };
}

// ---------------------------------------------------------------------------

function loadConnectionConfig(): ConnectionConfig {
  const configPath = join(process.cwd(), '.remediation-connection.json');

  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, 'utf8')) as ConnectionConfig;
  }

  // Fallback to env vars (set these in your CI/CD secrets instead of a file).
  const clientId = process.env['REMEDIATION_CLIENT_ID'] ?? '';
  const token    = process.env['REMEDIATION_TOKEN']     ?? '';
  const saasUrl  = (process.env['REMEDIATION_SAAS_URL'] ?? '').replace(/\/+$/, '');

  if (!clientId || !token || !saasUrl) {
    throw new Error(
      'Remediation Engine: no connection config found. ' +
      'Run `npx remediation-connect` or set REMEDIATION_CLIENT_ID, REMEDIATION_TOKEN, REMEDIATION_SAAS_URL.',
    );
  }

  return {
    client_id:            clientId,
    token,
    saas_url:             saasUrl,
    channel_type:         'polling',
    poll_url:             '/api/remediation/v1/instructions/pending',
    poll_interval_seconds: 30,
    connected_at:         new Date().toISOString(),
  };
}
