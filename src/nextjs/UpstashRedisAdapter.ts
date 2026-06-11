/**
 * Minimal Upstash Redis adapter using the REST API via fetch().
 *
 * No npm dependency — uses the global fetch() available in both the
 * Next.js Edge Runtime and Node.js ≥ 18. Works identically in both.
 *
 * Only the operations needed by the Next.js agent are implemented.
 * All commands go through the Upstash REST pipeline endpoint for efficiency.
 */

/** Common interface implemented by both UpstashRedisAdapter and InMemoryRedisAdapter. */
export interface RedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ex: number): Promise<void>;
  setNx(key: string, value: string, ex: number): Promise<boolean>;
  del(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  ttl(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
  smembers(key: string): Promise<string[]>;
  sadd(key: string, members: string[]): Promise<void>;
  srem(key: string, members: string[]): Promise<void>;
  mget(keys: string[]): Promise<Array<string | null>>;
  pipeline(commands: [string, ...string[]][]): Promise<unknown[]>;
}

export interface UpstashConfig {
  readonly url:   string;  // UPSTASH_REDIS_REST_URL
  readonly token: string;  // UPSTASH_REDIS_REST_TOKEN
}

type RedisCommand = [string, ...string[]];

interface UpstashResult {
  result: unknown;
  error?: string;
}

export class UpstashRedisAdapter implements RedisAdapter {
  constructor(private readonly cfg: UpstashConfig) {}

  // ── Single command ──────────────────────────────────────────────────────────

  private async exec(command: RedisCommand): Promise<unknown> {
    const res = await fetch(this.cfg.url, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${this.cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
      // Edge Runtime does not support cache: 'no-store' in all versions,
      // but we don't want stale fetch caching from Next.js.
      cache: 'no-store',
    } as RequestInit);

    if (!res.ok) {
      throw new Error(`Upstash HTTP ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as UpstashResult;
    if (data.error) throw new Error(`Redis error: ${data.error}`);
    return data.result;
  }

  // ── Pipeline (two roundtrips saved for bulk ops) ────────────────────────────

  async pipeline(commands: RedisCommand[]): Promise<unknown[]> {
    if (commands.length === 0) return [];

    const res = await fetch(`${this.cfg.url}/pipeline`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${this.cfg.token}`,
        'Content-Type': 'application/json',
      },
      body:  JSON.stringify(commands),
      cache: 'no-store',
    } as RequestInit);

    if (!res.ok) {
      throw new Error(`Upstash pipeline HTTP ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as UpstashResult[];
    return data.map((r) => {
      if (r.error) throw new Error(`Redis pipeline error: ${r.error}`);
      return r.result;
    });
  }

  // ── String ops ──────────────────────────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    return (await this.exec(['GET', key])) as string | null;
  }

  async set(key: string, value: string, ex: number): Promise<void> {
    await this.exec(['SET', key, value, 'EX', String(ex)]);
  }

  /**
   * SET NX EX — atomic. Returns true if key was set (did not exist), false if it already existed.
   * Used for nonce deduplication in the webhook handler.
   */
  async setNx(key: string, value: string, ex: number): Promise<boolean> {
    const result = await this.exec(['SET', key, value, 'EX', String(ex), 'NX']);
    return result === 'OK';
  }

  async del(key: string): Promise<void> {
    await this.exec(['DEL', key]);
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.exec(['EXISTS', key]);
    return result === 1;
  }

  async ttl(key: string): Promise<number> {
    return (await this.exec(['TTL', key])) as number;
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.exec(['EXPIRE', key, String(seconds)]);
  }

  // ── Set ops ─────────────────────────────────────────────────────────────────

  async smembers(key: string): Promise<string[]> {
    return ((await this.exec(['SMEMBERS', key])) as string[] | null) ?? [];
  }

  async sadd(key: string, members: string[]): Promise<void> {
    if (members.length === 0) return;
    await this.exec(['SADD', key, ...members]);
  }

  async srem(key: string, members: string[]): Promise<void> {
    if (members.length === 0) return;
    await this.exec(['SREM', key, ...members]);
  }

  // ── Batch read ──────────────────────────────────────────────────────────────

  async mget(keys: string[]): Promise<Array<string | null>> {
    if (keys.length === 0) return [];
    return (await this.exec(['MGET', ...keys])) as Array<string | null>;
  }
}

// ── Factories ─────────────────────────────────────────────────────────────────

/**
 * Returns an Upstash adapter if UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 * are set, otherwise falls back to the in-memory adapter.
 *
 * Use this in all Next.js interceptor code — never throw on missing Upstash config.
 */
export async function createRedisAdapter(): Promise<RedisAdapter> {
  const url   = process.env['UPSTASH_REDIS_REST_URL']   ?? '';
  const token = process.env['UPSTASH_REDIS_REST_TOKEN'] ?? '';

  if (url && token) {
    return new UpstashRedisAdapter({ url, token });
  }

  const { createInMemoryAdapter } = await import('./InMemoryRedisAdapter.js');
  return createInMemoryAdapter();
}

/** @deprecated Use createRedisAdapter() instead. */
export function createUpstashAdapter(): UpstashRedisAdapter {
  const url   = process.env['UPSTASH_REDIS_REST_URL']   ?? '';
  const token = process.env['UPSTASH_REDIS_REST_TOKEN'] ?? '';

  if (!url || !token) {
    throw new Error(
      '[Develler] UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set.',
    );
  }

  return new UpstashRedisAdapter({ url, token });
}
