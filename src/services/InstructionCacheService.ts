import type { Redis } from 'ioredis';
import { InstructionCollection, RuntimeInstruction } from '../types/instructions.js';

/**
 * Reads and writes RuntimeInstructions from/to Redis.
 *
 * Exact equivalent of the PHP InstructionCacheService.
 * Key strategy: one STRING key per instruction with its own TTL, plus a SET
 * index so getActive() can SMEMBERS → MGET in two roundtrips.
 *
 * Namespace:
 *   remediation:instruction:{clientId}:{instructionId}  → JSON string
 *   remediation:active:{clientId}                       → SET of instruction IDs
 */
export class InstructionCacheService {
  private readonly indexKey: string;

  constructor(
    private readonly redis: Redis,
    private readonly clientId: string,
  ) {
    this.indexKey = `remediation:active:${clientId}`;
  }

  async store(instruction: RuntimeInstruction): Promise<void> {
    const ttl = Math.max(1, instruction.expiresAt - Math.floor(Date.now() / 1000));
    const key = this.instructionKey(instruction.instructionId);

    await this.redis.set(key, JSON.stringify(instruction.toJSON()), 'EX', ttl);
    await this.redis.sadd(this.indexKey, instruction.instructionId);

    // Extend index TTL to at least match the instruction's TTL.
    const currentTtl = await this.redis.ttl(this.indexKey);
    if (currentTtl < ttl) {
      await this.redis.expire(this.indexKey, ttl + 60);
    }
  }

  /**
   * Return all currently active instructions.
   * Two roundtrips: SMEMBERS → MGET. <1ms on a local socket.
   */
  async getActive(): Promise<InstructionCollection> {
    const ids = await this.redis.smembers(this.indexKey);

    if (ids.length === 0) return InstructionCollection.empty();

    const keys   = ids.map((id) => this.instructionKey(id));
    const values = await this.redis.mget(...keys);

    const instructions: RuntimeInstruction[] = [];
    const staleIds: string[] = [];

    for (let i = 0; i < ids.length; i++) {
      const json = values[i];

      if (json == null) {
        staleIds.push(ids[i] as string);
        continue;
      }

      try {
        const raw = JSON.parse(json) as Record<string, unknown>;
        const instruction = RuntimeInstruction.fromJSON(raw);
        if (instruction.isEffective()) {
          instructions.push(instruction);
        }
      } catch {
        staleIds.push(ids[i] as string);
      }
    }

    if (staleIds.length > 0) {
      await this.redis.srem(this.indexKey, ...staleIds);
    }

    return new InstructionCollection(instructions);
  }

  async evict(instructionId: string): Promise<void> {
    await this.redis.del(this.instructionKey(instructionId));
    await this.redis.srem(this.indexKey, instructionId);
  }

  /** Remove every cached instruction whose ID is not in `keepIds`. */
  async evictAllExcept(keepIds: Set<string>): Promise<void> {
    const currentIds = await this.redis.smembers(this.indexKey);
    for (const id of currentIds) {
      if (!keepIds.has(id)) {
        await this.evict(id);
      }
    }
  }

  private instructionKey(instructionId: string): string {
    return `remediation:instruction:${this.clientId}:${instructionId}`;
  }
}
