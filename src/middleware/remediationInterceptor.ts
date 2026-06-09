import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AgentConnectionInterface } from '../contracts/agentConnection.js';
import type { LifecycleInterceptorInterface } from '../contracts/lifecycleInterceptor.js';
import type { MaskRule } from '../types/instructions.js';
import { CircuitBreakerService } from '../services/CircuitBreakerService.js';
import { MaskingEngine } from '../services/MaskingEngine.js';
import { logger } from '../logger.js';

/**
 * Production-grade in-memory interceptor for Express (Mode B).
 *
 * Handle flow (mirrors the PHP RemediationInterceptor exactly):
 *  1. Circuit breaker open?  → call next() immediately, zero overhead.
 *  2. Load active instructions from Redis.
 *  3. Route-block match?  → respond with 503/custom, do not call next().
 *  4. Override res.json() BEFORE calling next() so the route handler's
 *     response is captured before it reaches the socket.
 *  5. Inside the override: inject headers, deep-clone, mask PII, swap.
 *  6. Call next().
 *
 * On ANY exception in steps 2–5: trip circuit breaker, log silently,
 * call next() with the original res.json untouched. Never a partial mask.
 *
 * Node.js-specific challenge solved here:
 *   Express does not buffer outbound response bodies. We intercept res.json()
 *   and res.send() before next() is called, so that when the downstream
 *   handler calls res.json(data), our closure runs first.
 */
export class RemediationInterceptor implements LifecycleInterceptorInterface {
  constructor(
    private readonly connection: AgentConnectionInterface,
    private readonly masker:     MaskingEngine,
    private readonly breaker:    CircuitBreakerService,
    private readonly enabled:    boolean,
  ) {}

  /** Returns an Express RequestHandler — the function registered via app.use(). */
  handler(): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      if (!this.enabled) {
        next();
        return;
      }

      // Step 1 — circuit breaker gate.
      if (await this.isCircuitBreakerOpen()) {
        next();
        return;
      }

      // Step 2 — load instructions from Redis.
      let instructions;
      try {
        instructions = await this.connection.getActiveInstructions();
      } catch (err) {
        await this.tripCircuitBreaker(err instanceof Error ? err : new Error(String(err)));
        next();
        return;
      }

      if (instructions.isEmpty()) {
        next();
        return;
      }

      // Step 3 — route-block check (before running the application handler).
      let blocked = false;
      try {
        blocked = !(await this.interceptRequest(req, res, instructions.matchingRouteBlock(req) !== null
          ? instructions.matchingRouteBlock(req)!
          : null));
      } catch (err) {
        await this.tripCircuitBreaker(err instanceof Error ? err : new Error(String(err)));
        next();
        return;
      }

      if (blocked) return; // Response already sent by interceptRequest.

      // Step 4 — intercept res.json() before calling next().
      // We override the method here so that when the downstream route handler
      // calls res.json(body), our version executes instead.
      const originalJson = res.json.bind(res) as (body?: unknown) => Response;
      const maskRules    = instructions.maskRules();
      const headers      = instructions.injectHeaders();
      const hasMasks     = instructions.hasMaskRules();

      res.json = (body?: unknown): Response => {
        try {
          // Step 5a — inject headers.
          for (const [name, value] of Object.entries(headers)) {
            res.setHeader(name, value);
          }

          // Step 5b — deep-clone, mask, swap.
          if (hasMasks && body !== undefined) {
            const masked = this.applyMaskingRules(body, maskRules);
            return originalJson(masked);
          }
        } catch (err) {
          // Trip breaker async; do not await here (we are inside a sync method).
          void this.tripCircuitBreaker(err instanceof Error ? err : new Error(String(err)));
          // Return original body — never a partial mask.
          return originalJson(body);
        }

        return originalJson(body);
      };

      // Step 6 — run the application handler.
      next();
    };
  }

  // ---------------------------------------------------------------------------
  // LifecycleInterceptorInterface
  // ---------------------------------------------------------------------------

  async interceptRequest(req: Request, res: Response): Promise<boolean>;
  async interceptRequest(req: Request, res: Response, block: ReturnType<typeof this.connection.getActiveInstructions> extends Promise<infer T> ? T extends { matchingRouteBlock: (...args: unknown[]) => infer R } ? R : null : null): Promise<boolean>;
  async interceptRequest(req: Request, res: Response, block?: unknown): Promise<boolean> {
    // When called from the handler with a pre-resolved block:
    if (block !== undefined) {
      const routeBlock = block as { responseStatus: number; responseBody: Record<string, unknown> } | null;
      if (routeBlock !== null) {
        res.status(routeBlock.responseStatus).json(routeBlock.responseBody);
        return false; // blocked
      }
      return true; // pass through
    }

    // When called directly (interface compliance):
    try {
      const instructions = await this.connection.getActiveInstructions();
      const matched      = instructions.matchingRouteBlock(req);
      if (matched !== null) {
        res.status(matched.responseStatus).json(matched.responseBody);
        return false;
      }
      return true;
    } catch {
      return true; // fail-safe pass-through
    }
  }

  applyMaskingRules(data: unknown, maskRules: MaskRule[]): unknown {
    return this.masker.apply(data, maskRules);
  }

  async isCircuitBreakerOpen(): Promise<boolean> {
    return this.breaker.isOpen();
  }

  async tripCircuitBreaker(reason: Error): Promise<void> {
    await this.breaker.trip(reason);
  }

  async resetCircuitBreaker(): Promise<void> {
    await this.breaker.reset();
  }
}
