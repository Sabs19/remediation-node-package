/**
 * On-request instruction fetching with Redis cache.
 *
 * Replaces the background polling loop used by the Express agent.
 * On each request:
 *   1. Read from Redis cache (fast — ~1ms via Upstash).
 *   2. If no poll has happened in the last 30 seconds, fetch fresh from SaaS.
 *   3. Store results and return InstructionCollection.
 *
 * Edge Runtime compatible — uses only fetch() and standard Web APIs.
 * No Node.js-specific imports.
 */

import { InstructionCollection, RuntimeInstruction } from '../types/instructions.js';
import type { ConnectionConfig, WireEnvelope, WireRuntimeInstructionPayload } from '../types/wireProtocol.js';
import type { RedisAdapter } from './UpstashRedisAdapter.js';

const POLL_INTERVAL_SECONDS = 30;

export class InstructionFetcher {
  private readonly indexKey:     string;
  private readonly pollMarkerKey: string;

  constructor(
    private readonly redis:      RedisAdapter,
    private readonly connection: ConnectionConfig,
  ) {
    this.indexKey      = `remediation:active:${connection.client_id}`;
    this.pollMarkerKey = `remediation:polled_at:${connection.client_id}`;
  }

  /**
   * Returns active instructions. Polls the SaaS if the cache has gone stale.
   * Called on every intercepted request — must be fast in the happy path.
   */
  async getActive(): Promise<InstructionCollection> {
    const pollDue = !(await this.redis.exists(this.pollMarkerKey));

    if (pollDue) {
      await this.pollAndCache();
    }

    return this.readFromCache();
  }

  // ── Cache read ──────────────────────────────────────────────────────────────

  private async readFromCache(): Promise<InstructionCollection> {
    const ids = await this.redis.smembers(this.indexKey);
    if (ids.length === 0) return InstructionCollection.empty();

    const keys   = ids.map((id) => this.instructionKey(id));
    const values = await this.redis.mget(keys);

    const instructions: RuntimeInstruction[] = [];
    const staleIds: string[] = [];

    for (let i = 0; i < ids.length; i++) {
      const json = values[i];
      const id   = ids[i];

      if (json == null || id == null) {
        if (id != null) staleIds.push(id);
        continue;
      }

      try {
        const raw         = JSON.parse(json) as Record<string, unknown>;
        const instruction = RuntimeInstruction.fromJSON(raw);
        if (instruction.isEffective()) {
          instructions.push(instruction);
        }
      } catch {
        staleIds.push(id);
      }
    }

    if (staleIds.length > 0) {
      await this.redis.srem(this.indexKey, staleIds);
    }

    return new InstructionCollection(instructions);
  }

  // ── SaaS poll ───────────────────────────────────────────────────────────────

  private async pollAndCache(): Promise<void> {
    try {
      const res = await fetch(
        `${this.connection.saas_url}${this.connection.poll_url}`,
        {
          headers: {
            'X-Remediation-Client-Id': this.connection.client_id,
            'X-Remediation-Token':     this.connection.token,
            Accept:                    'application/json',
          },
          cache: 'no-store',
        } as RequestInit,
      );

      if (!res.ok) return;

      const data = (await res.json()) as { instructions?: WireEnvelope[] };
      const envelopes = data.instructions ?? [];

      const activeIds = new Set<string>();

      for (const raw of envelopes) {
        // Full async HMAC verification — must pass before the payload is trusted.
        const valid = await this.verifyEnvelopeSignature(raw);
        if (!valid) continue;

        try {
          const instruction = RuntimeInstruction.fromWirePayload(
            raw.payload as WireRuntimeInstructionPayload,
          );

          await this.cacheInstruction(instruction);
          activeIds.add(instruction.instructionId);

          // Fire-and-forget acknowledge (best effort — never block the request).
          void this.acknowledge(instruction.instructionId);
        } catch {
          // Malformed payload — skip silently.
        }
      }

      // Evict anything the SaaS no longer considers active.
      const currentIds = await this.redis.smembers(this.indexKey);
      const stale = currentIds.filter((id) => !activeIds.has(id));
      if (stale.length > 0) {
        await this.redis.srem(this.indexKey, stale);
        for (const id of stale) {
          await this.redis.del(this.instructionKey(id));
        }
      }
    } catch {
      // Network error — work with whatever is in the cache.
    } finally {
      // Mark poll as fresh regardless of outcome so we don't hammer the SaaS.
      await this.redis.set(this.pollMarkerKey, '1', POLL_INTERVAL_SECONDS);
    }
  }

  private async cacheInstruction(instruction: RuntimeInstruction): Promise<void> {
    const ttl = Math.max(1, instruction.expiresAt - Math.floor(Date.now() / 1000));
    const key = this.instructionKey(instruction.instructionId);

    await this.redis.set(key, JSON.stringify(instruction.toJSON()), ttl);
    await this.redis.sadd(this.indexKey, [instruction.instructionId]);

    const currentTtl = await this.redis.ttl(this.indexKey);
    if (currentTtl < ttl) {
      await this.redis.expire(this.indexKey, ttl + 60);
    }
  }

  private async acknowledge(instructionId: string): Promise<void> {
    try {
      await fetch(
        `${this.connection.saas_url}/api/remediation/v1/instructions/${instructionId}/acknowledge`,
        {
          method:  'POST',
          headers: {
            'X-Remediation-Client-Id': this.connection.client_id,
            'X-Remediation-Token':     this.connection.token,
          },
          cache: 'no-store',
        } as RequestInit,
      );
    } catch {
      // Best effort — never throw.
    }
  }

  // ── Signature verification (HMAC-SHA256 via Web Crypto) ─────────────────────

  /**
   * Full HMAC-SHA256 envelope verification using the Web Crypto API.
   *
   * Compatible with both Edge Runtime and Node.js ≥ 18 via the globalThis.crypto
   * subtle interface. Returns false on any verification failure so bad envelopes
   * are skipped gracefully without throwing into the poll pipeline.
   *
   * Security properties:
   *  - Constant-time comparison via XOR accumulator (matches timingSafeEqual semantics).
   *  - Nonce and issued_at window checks are handled by AgentConnectionService on the
   *    SaaS side; the client trust boundary is the HMAC here.
   *  - client_id structural check is performed first to short-circuit obviously
   *    foreign envelopes before any crypto work is done.
   */
  private async verifyEnvelopeSignature(envelope: WireEnvelope): Promise<boolean> {
    try {
      // Short-circuit: reject envelopes not addressed to this agent.
      if (
        envelope.client_id !== this.connection.client_id ||
        typeof envelope.hmac_sha256 !== 'string' ||
        envelope.hmac_sha256.length !== 64
      ) {
        return false;
      }

      const payload = (envelope.payload ?? {}) as Record<string, unknown>;

      const canonical = [
        String(envelope.protocol_version ?? ''),
        String(envelope.message_id       ?? ''),
        String(envelope.message_type     ?? ''),
        String(envelope.client_id        ?? ''),
        String(envelope.issued_at        ?? ''),
        String(envelope.nonce            ?? ''),
        this.base64url(JSON.stringify(sortKeysDeep(payload))),
      ].join('.');

      // Import the raw token as an HMAC-SHA256 key (non-extractable).
      const key = await globalThis.crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(this.connection.token),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );

      // Compute the expected digest.
      const sigBuffer = await globalThis.crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(canonical),
      );

      const expectedHex = Array.from(new Uint8Array(sigBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      const receivedHex = envelope.hmac_sha256.toLowerCase();

      // Constant-time XOR comparison — both strings are always the same length (64 hex chars).
      if (expectedHex.length !== receivedHex.length) return false;

      let diff = 0;
      for (let i = 0; i < expectedHex.length; i++) {
        diff |= expectedHex.charCodeAt(i) ^ receivedHex.charCodeAt(i);
      }

      return diff === 0;
    } catch {
      return false;
    }
  }

  private base64url(data: string): string {
    return btoa(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  private instructionKey(instructionId: string): string {
    return `remediation:instruction:${this.connection.client_id}:${instructionId}`;
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sortKeysDeep(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return obj;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as object).sort()) {
    sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}
