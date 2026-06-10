import { createHmac, timingSafeEqual } from 'crypto';
import type { Redis } from 'ioredis';
import axios from 'axios';
import type { AgentConnectionInterface } from '../contracts/agentConnection.js';
import type { ConnectionConfig, WireEnvelope, WireRuntimeInstructionPayload } from '../types/wireProtocol.js';
import { InstructionCollection, RuntimeInstruction } from '../types/instructions.js';
import { InstructionCacheService } from './InstructionCacheService.js';
import { SignatureError } from '../exceptions/SignatureError.js';
import { ReplayError } from '../exceptions/ReplayError.js';
import { logger } from '../logger.js';

const PROTOCOL_MAJOR      = 1;
const NONCE_TTL           = 300;
const ISSUED_AT_TOLERANCE = 300;

/**
 * Implements AgentConnectionInterface for Node.js.
 * Exact behavioural equivalent of the PHP AgentConnectionService.
 *
 * Key differences vs PHP:
 *  - All methods are async (ioredis returns Promises).
 *  - HMAC: crypto.createHmac + crypto.timingSafeEqual (replaces hash_hmac + hash_equals).
 *  - Nonce dedup: ioredis SET NX EX (same semantics as PHP Redis::set NX).
 *  - base64url: Buffer.toString('base64url') — available in Node ≥ 16.
 */
export class AgentConnectionService implements AgentConnectionInterface {
  constructor(
    private readonly redis: Redis,
    private readonly cache: InstructionCacheService,
    private readonly config: ConnectionConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // AgentConnectionInterface
  // ---------------------------------------------------------------------------

  async verifyEnvelope(raw: unknown): Promise<WireEnvelope> {
    if (typeof raw !== 'object' || raw === null) {
      throw new SignatureError('Envelope must be a non-null object.');
    }

    const envelope = raw as Record<string, unknown>;

    this.assertProtocolVersion(envelope);
    this.assertIssuedAtWindow(envelope);
    this.assertClientId(envelope);
    await this.assertNonceUnique(envelope);
    this.assertHmac(envelope);

    return raw as WireEnvelope;
  }

  async cacheInstruction(instruction: RuntimeInstruction): Promise<void> {
    await this.cache.store(instruction);
  }

  async getActiveInstructions(): Promise<InstructionCollection> {
    return this.cache.getActive();
  }

  async acknowledgeInstruction(instructionId: string): Promise<void> {
    try {
      await axios.post(
        `${this.config.saas_url}/api/remediation/v1/instructions/${instructionId}/acknowledge`,
        {},
        { headers: this.authHeaders(), timeout: 5000 },
      );
    } catch (err) {
      logger.warn('RemediationEngine: acknowledge failed.', {
        instructionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async pollPendingInstructions(): Promise<InstructionCollection> {
    try {
      const response = await axios.get<{ instructions: WireEnvelope[] }>(
        `${this.config.saas_url}${this.config.poll_url}`,
        { headers: this.authHeaders(), timeout: 10000 },
      );

      const instructions: RuntimeInstruction[] = [];

      for (const raw of response.data.instructions ?? []) {
        try {
          const envelope    = await this.verifyEnvelope(raw);
          const instruction = RuntimeInstruction.fromWirePayload(
            envelope.payload as WireRuntimeInstructionPayload,
          );
          await this.cacheInstruction(instruction);
          await this.acknowledgeInstruction(instruction.instructionId);
          instructions.push(instruction);
        } catch (err) {
          logger.error('RemediationEngine: poll envelope verification failed.', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Evict any cached instructions that the SaaS no longer considers active
      // (expired, revoked, or manually expired via the dashboard).
      const activeIds = new Set(instructions.map((i) => i.instructionId));
      await this.cache.evictAllExcept(activeIds);

      return new InstructionCollection(instructions);
    } catch (err) {
      logger.error('RemediationEngine: poll request failed.', {
        error: err instanceof Error ? err.message : String(err),
      });
      return InstructionCollection.empty();
    }
  }

  // ---------------------------------------------------------------------------
  // Verification helpers
  // ---------------------------------------------------------------------------

  private assertProtocolVersion(envelope: Record<string, unknown>): void {
    const version = String(envelope['protocol_version'] ?? '');
    const major   = parseInt(version.split('.')[0] ?? '0', 10);
    if (major !== PROTOCOL_MAJOR) {
      throw new SignatureError(`Unsupported protocol major version: ${version}`);
    }
  }

  private assertIssuedAtWindow(envelope: Record<string, unknown>): void {
    const issuedAt = Number(envelope['issued_at'] ?? 0);
    const delta    = Math.abs(Math.floor(Date.now() / 1000) - issuedAt);
    if (delta > ISSUED_AT_TOLERANCE) {
      throw new SignatureError(`Envelope issued_at out of tolerance window (${delta}s).`);
    }
  }

  private assertClientId(envelope: Record<string, unknown>): void {
    if (envelope['client_id'] !== this.config.client_id) {
      throw new SignatureError('client_id mismatch.');
    }
  }

  private async assertNonceUnique(envelope: Record<string, unknown>): Promise<void> {
    const nonce    = String(envelope['nonce']     ?? '');
    const clientId = String(envelope['client_id'] ?? '');
    const nonceKey = `remediation:nonce:${clientId}:${nonce}`;

    try {
      // SET NX EX — atomic, identical semantics to PHP Redis::set NX
      const result = await this.redis.set(nonceKey, '1', 'EX', NONCE_TTL, 'NX');
      if (result === null) {
        throw new ReplayError(`Replayed nonce detected: ${nonce}`);
      }
    } catch (err) {
      if (err instanceof ReplayError) throw err;
      // Redis unavailable — skip dedup (circuit breaker handles safety).
      logger.warn('RemediationEngine: nonce Redis unavailable, skipping dedup.', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Recompute HMAC-SHA256 over the canonical string and timing-safe compare.
   * Equivalent to PHP hash_hmac('sha256', ...) + hash_equals().
   */
  private assertHmac(envelope: Record<string, unknown>): void {
    const payload  = (envelope['payload'] ?? {}) as Record<string, unknown>;
    const canonical = [
      String(envelope['protocol_version'] ?? ''),
      String(envelope['message_id']       ?? ''),
      String(envelope['message_type']     ?? ''),
      String(envelope['client_id']        ?? ''),
      String(envelope['issued_at']        ?? ''),
      String(envelope['nonce']            ?? ''),
      Buffer.from(JSON.stringify(sortKeysDeep(payload))).toString('base64url'),
    ].join('.');

    const expected = createHmac('sha256', this.config.token)
      .update(canonical)
      .digest('hex');

    const received = String(envelope['hmac_sha256'] ?? '').toLowerCase();

    if (expected.length !== received.length) {
      throw new SignatureError('HMAC verification failed.');
    }

    // crypto.timingSafeEqual requires same-length Buffers.
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(received);

    if (!timingSafeEqual(expectedBuf, receivedBuf)) {
      throw new SignatureError('HMAC verification failed.');
    }
  }

  // ---------------------------------------------------------------------------

  private authHeaders(): Record<string, string> {
    return {
      'X-Remediation-Client-Id': this.config.client_id,
      'X-Remediation-Token':     this.config.token,
    };
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sortKeysDeep(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return obj;

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as object).sort()) {
    sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}
