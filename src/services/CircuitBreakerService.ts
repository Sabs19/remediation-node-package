import type { Redis } from 'ioredis';
import { logger } from '../logger.js';

/**
 * Three-state circuit breaker: CLOSED → OPEN → HALF-OPEN → CLOSED.
 *
 * Exact behavioural equivalent of the PHP CircuitBreakerService.
 * State is stored in Redis with a configurable TTL so it auto-resets.
 *
 * Node.js-specific: when Redis itself is unavailable we fall back to a
 * module-level in-process flag cleared via setTimeout (single-threaded
 * event loop — no locking needed, unlike PHP-FPM per-request processes).
 */
export class CircuitBreakerService {
  private readonly redisKey: string;
  private readonly ttlSeconds: number;

  // Module-level state survives across requests in a single Node.js process.
  private static inProcessOpen = false;
  private static resetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly clientId: string,
    ttlSeconds: number,
  ) {
    this.redisKey   = `remediation:circuit_breaker:${clientId}`;
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * Returns true when the breaker is OPEN — all interception must be skipped.
   * If Redis is down, trips in-process and returns true.
   */
  async isOpen(): Promise<boolean> {
    if (CircuitBreakerService.inProcessOpen) return true;

    try {
      const exists = await this.redis.exists(this.redisKey);
      return exists === 1;
    } catch {
      // Redis unavailable — open in-process and protect production.
      this.tripInProcess(new Error('Redis unavailable during isOpen check'));
      return true;
    }
  }

  async trip(reason: Error): Promise<void> {
    logger.error('RemediationEngine circuit breaker tripped.', {
      reason: reason.message,
      name:   reason.name,
    });

    const payload = JSON.stringify({
      state:      'open',
      tripped_at: Math.floor(Date.now() / 1000),
      reason:     reason.message,
    });

    try {
      await this.redis.set(this.redisKey, payload, 'EX', this.ttlSeconds);
    } catch {
      // Redis is the problem — fall back to in-process.
      this.tripInProcess(reason);
    }
  }

  async reset(): Promise<void> {
    CircuitBreakerService.inProcessOpen = false;
    if (CircuitBreakerService.resetTimer !== null) {
      clearTimeout(CircuitBreakerService.resetTimer);
      CircuitBreakerService.resetTimer = null;
    }
    try {
      await this.redis.del(this.redisKey);
    } catch {
      // Ignore — key will expire on its own.
    }
  }

  // ---------------------------------------------------------------------------

  private tripInProcess(reason: Error): void {
    CircuitBreakerService.inProcessOpen = true;

    logger.warn('RemediationEngine: using in-process circuit breaker fallback.', {
      reason: reason.message,
    });

    if (CircuitBreakerService.resetTimer !== null) {
      clearTimeout(CircuitBreakerService.resetTimer);
    }

    CircuitBreakerService.resetTimer = setTimeout(() => {
      CircuitBreakerService.inProcessOpen = false;
      CircuitBreakerService.resetTimer    = null;
    }, this.ttlSeconds * 1000);
  }
}
