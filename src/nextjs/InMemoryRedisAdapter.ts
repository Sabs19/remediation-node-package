/**
 * In-memory Redis adapter — TTL-aware Map/Set store.
 *
 * Used as a fallback when Upstash env vars are not configured.
 * Works on any host where the Node.js process persists between requests
 * (self-hosted, Railway, Render, Fly.io, etc.).
 *
 * On Vercel/serverless the process may be recycled between requests, so
 * in-memory state does not survive cold starts. For Vercel, set
 * UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to use Upstash instead.
 */

import type { RedisAdapter } from './UpstashRedisAdapter.js';

interface StringEntry {
  value:     string;
  expiresAt: number | null; // ms timestamp; null = no expiry
}

interface SetEntry {
  members:   Set<string>;
  expiresAt: number | null;
}

class InMemoryRedisAdapter implements RedisAdapter {
  private readonly strings = new Map<string, StringEntry>();
  private readonly sets    = new Map<string, SetEntry>();

  private expired(expiresAt: number | null): boolean {
    return expiresAt !== null && Date.now() > expiresAt;
  }

  async get(key: string): Promise<string | null> {
    const e = this.strings.get(key);
    if (!e || this.expired(e.expiresAt)) { this.strings.delete(key); return null; }
    return e.value;
  }

  async set(key: string, value: string, ex: number): Promise<void> {
    this.strings.set(key, { value, expiresAt: Date.now() + ex * 1000 });
  }

  async setNx(key: string, value: string, ex: number): Promise<boolean> {
    const e = this.strings.get(key);
    if (e && !this.expired(e.expiresAt)) return false;
    await this.set(key, value, ex);
    return true;
  }

  async del(key: string): Promise<void> {
    this.strings.delete(key);
    this.sets.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async ttl(key: string): Promise<number> {
    const e = this.strings.get(key);
    if (!e || this.expired(e.expiresAt)) return -2;
    if (e.expiresAt === null) return -1;
    return Math.max(0, Math.ceil((e.expiresAt - Date.now()) / 1000));
  }

  async expire(key: string, seconds: number): Promise<void> {
    const expiresAt = Date.now() + seconds * 1000;
    const s = this.strings.get(key);
    if (s) s.expiresAt = expiresAt;
    const set = this.sets.get(key);
    if (set) set.expiresAt = expiresAt;
  }

  async smembers(key: string): Promise<string[]> {
    const e = this.sets.get(key);
    if (!e || this.expired(e.expiresAt)) { this.sets.delete(key); return []; }
    return [...e.members];
  }

  async sadd(key: string, members: string[]): Promise<void> {
    if (members.length === 0) return;
    let e = this.sets.get(key);
    if (!e || this.expired(e.expiresAt)) {
      e = { members: new Set(), expiresAt: null };
      this.sets.set(key, e);
    }
    for (const m of members) e.members.add(m);
  }

  async srem(key: string, members: string[]): Promise<void> {
    if (members.length === 0) return;
    const e = this.sets.get(key);
    if (!e) return;
    for (const m of members) e.members.delete(m);
  }

  async mget(keys: string[]): Promise<Array<string | null>> {
    return Promise.all(keys.map((k) => this.get(k)));
  }

  async pipeline(commands: [string, ...string[]][]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const [cmd, ...args] of commands) {
      switch (cmd.toUpperCase()) {
        case 'GET':    results.push(await this.get(args[0]!)); break;
        case 'SET':    await this.set(args[0]!, args[1]!, Number(args[3] ?? 60)); results.push('OK'); break;
        case 'DEL':    await this.del(args[0]!); results.push(1); break;
        case 'EXISTS': results.push((await this.exists(args[0]!)) ? 1 : 0); break;
        default:       results.push(null);
      }
    }
    return results;
  }
}

// Module-level singleton — persists across requests within the same process.
const sharedMemory = new InMemoryRedisAdapter();

export function createInMemoryAdapter(): InMemoryRedisAdapter {
  return sharedMemory;
}
