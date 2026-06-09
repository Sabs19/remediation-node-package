import type { Request, Response } from 'express';
import type { MaskRule } from '../types/instructions.js';

export interface LifecycleInterceptorInterface {
  /**
   * Hook into the inbound HTTP request.
   * Returns true if the request should continue, false if it was blocked.
   * Must never throw.
   */
  interceptRequest(req: Request, res: Response): Promise<boolean>;

  /**
   * Apply PII masking rules to a data structure.
   * Operates on a deep clone — never mutates the original.
   */
  applyMaskingRules(data: unknown, maskRules: MaskRule[]): unknown;

  /** Returns true when the circuit breaker is open (all interception bypassed). */
  isCircuitBreakerOpen(): Promise<boolean>;

  /** Trip the circuit breaker on Redis failure or unhandled exception. */
  tripCircuitBreaker(reason: Error): Promise<void>;

  /** Reset the circuit breaker manually. Also auto-resets via Redis TTL. */
  resetCircuitBreaker(): Promise<void>;
}
