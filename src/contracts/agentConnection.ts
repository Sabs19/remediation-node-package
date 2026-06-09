import type { WireEnvelope } from '../types/wireProtocol.js';
import type { InstructionCollection, RuntimeInstruction } from '../types/instructions.js';

export interface AgentConnectionInterface {
  /**
   * Verify HMAC-SHA256 envelope signature plus replay-attack guards.
   * Uses crypto.timingSafeEqual. Throws SignatureError | ReplayError on failure.
   */
  verifyEnvelope(raw: unknown): Promise<WireEnvelope>;

  /**
   * Persist a verified RuntimeInstruction to the Redis instruction cache.
   * TTL derived from instruction.expiresAt - Date.now()/1000.
   */
  cacheInstruction(instruction: RuntimeInstruction): Promise<void>;

  /**
   * Return all currently active (non-expired) RuntimeInstructions from cache.
   * Must complete in <1ms on a local Redis socket. Never does I/O to SaaS.
   */
  getActiveInstructions(): Promise<InstructionCollection>;

  /**
   * POST acknowledgement to the SaaS for a delivered instruction.
   */
  acknowledgeInstruction(instructionId: string): Promise<void>;

  /**
   * Poll the SaaS pending-instructions endpoint (used when channel = 'polling').
   */
  pollPendingInstructions(): Promise<InstructionCollection>;
}
