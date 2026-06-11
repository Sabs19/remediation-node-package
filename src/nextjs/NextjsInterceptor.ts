/**
 * Next.js interceptor — middleware + route wrapper + webhook handler.
 *
 * Three exports:
 *
 *   createNextjsMiddleware()
 *     → Edge-compatible Next.js middleware. Handles route blocking and
 *       header injection on every matched request. No body interception.
 *
 *   withRemediation(handler)
 *     → Wraps an App Router route handler. Intercepts the JSON response body
 *       and applies PII masking rules. Runs in Node.js (not Edge).
 *
 *   handleRemediationWebhook
 *     → App Router POST handler for the webhook receiver endpoint.
 *       Receives pushed instructions from the SaaS, verifies HMAC, caches
 *       them in Redis. Runs in Node.js.
 *
 * Split by runtime requirement:
 *   createNextjsMiddleware → Edge Runtime (no Node.js APIs)
 *   withRemediation        → Node.js (uses MaskingEngine → createHash)
 *   handleRemediationWebhook → Node.js (uses crypto.createHmac + timingSafeEqual)
 */

import type { NextRequest } from 'next/server.js';
import { NextResponse }     from 'next/server.js';
import { InstructionCollection, RuntimeInstruction } from '../types/instructions.js';
import type { RouteBlock } from '../types/instructions.js';
import type { ConnectionConfig, WireEnvelope, WireRuntimeInstructionPayload } from '../types/wireProtocol.js';
import { InstructionFetcher } from './InstructionFetcher.js';
import { createUpstashAdapter } from './UpstashRedisAdapter.js';

// ── Connection config loader ──────────────────────────────────────────────────

function loadConnection(): ConnectionConfig {
  const clientId = process.env['REMEDIATION_CLIENT_ID'] ?? '';
  const token    = process.env['REMEDIATION_TOKEN']     ?? '';
  const saasUrl  = (process.env['REMEDIATION_SAAS_URL'] ?? '').replace(/\/+$/, '');

  if (!clientId || !token || !saasUrl) {
    throw new Error(
      '[Develler] REMEDIATION_CLIENT_ID, REMEDIATION_TOKEN, and REMEDIATION_SAAS_URL ' +
      'must all be set. Run `npx @develler/remediation-agent YOUR_KEY` locally, ' +
      'then add the printed values to your Vercel environment variables.',
    );
  }

  return {
    client_id:             clientId,
    token,
    saas_url:              saasUrl,
    channel_type:          'polling',
    poll_url:              '/api/remediation/v1/instructions/pending',
    poll_interval_seconds: 30,
    connected_at:          new Date().toISOString(),
  };
}

// ── Route matching (framework-agnostic) ───────────────────────────────────────

function matchesRouteBlock(
  method:   string,
  pathname: string,
  blocks:   RouteBlock[],
): RouteBlock | null {
  for (const block of blocks) {
    for (const route of block.blockedRoutes) {
      if (route.method.toUpperCase() !== method.toUpperCase()) continue;

      const pattern = route.path
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');

      if (new RegExp(`^${pattern}$`).test(pathname)) {
        return block;
      }
    }
  }
  return null;
}

function routeBlocksFrom(collection: InstructionCollection): RouteBlock[] {
  // Access the underlying instructions via the public API surface.
  // InstructionCollection exposes maskRules() and injectHeaders() but not
  // routeBlocks directly — we need to work around this using a cast.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = collection as any;
  const instructions: RuntimeInstruction[] = Array.isArray(raw['instructions'])
    ? (raw['instructions'] as RuntimeInstruction[])
    : [];
  return instructions.flatMap((i) => i.routeBlocks);
}

// ── Circuit breaker check (Edge-compatible) ───────────────────────────────────

async function isCircuitOpen(clientId: string): Promise<boolean> {
  try {
    const redis = createUpstashAdapter();
    return redis.exists(`remediation:circuit_breaker:${clientId}`);
  } catch {
    return false;
  }
}

// ── 1. createNextjsMiddleware ─────────────────────────────────────────────────

export interface NextjsMiddlewareConfig {
  /** Disable the interceptor. Useful for local dev. Default: true. */
  enabled?: boolean;
}

/**
 * Returns a Next.js middleware function.
 * Register it in middleware.ts at the project root:
 *
 *   import { createNextjsMiddleware } from '@develler/remediation-agent/nextjs'
 *   export const middleware = createNextjsMiddleware()
 *   export const config = { matcher: '/api/:path*' }
 */
export function createNextjsMiddleware(
  cfg: NextjsMiddlewareConfig = {},
): (req: NextRequest) => Promise<NextResponse> {
  const enabled = cfg.enabled ?? (process.env['REMEDIATION_INTERCEPTOR_ENABLED'] !== 'false');

  return async (req: NextRequest): Promise<NextResponse> => {
    if (!enabled) return NextResponse.next();

    let connection: ConnectionConfig;
    try {
      connection = loadConnection();
    } catch {
      // Misconfigured — pass through silently so the app still works.
      return NextResponse.next();
    }

    try {
      if (await isCircuitOpen(connection.client_id)) {
        return NextResponse.next();
      }

      const redis   = createUpstashAdapter();
      const fetcher = new InstructionFetcher(redis, connection);
      const instructions = await fetcher.getActive();

      if (instructions.isEmpty()) return NextResponse.next();

      const method   = req.method;
      const pathname = new URL(req.url).pathname;

      // ── Route block ──────────────────────────────────────────────────────
      const blocks = routeBlocksFrom(instructions);
      const matched = matchesRouteBlock(method, pathname, blocks);
      if (matched !== null) {
        return NextResponse.json(matched.responseBody, { status: matched.responseStatus });
      }

      // ── Header injection ─────────────────────────────────────────────────
      const headers = instructions.injectHeaders();
      if (Object.keys(headers).length === 0) return NextResponse.next();

      const res = NextResponse.next();
      for (const [name, value] of Object.entries(headers)) {
        res.headers.set(name, value);
      }
      return res;

    } catch {
      // Never break the request pipeline.
      return NextResponse.next();
    }
  };
}

// ── 2. withRemediation ────────────────────────────────────────────────────────

type AppRouterHandler = (req: NextRequest, ctx?: unknown) => Promise<Response>;

/**
 * Wraps an App Router route handler and applies PII masking to the JSON response.
 * Use this on API routes that return sensitive data.
 *
 * Runs in Node.js runtime (not Edge) because MaskingEngine uses node:crypto.
 *
 *   // app/api/users/route.ts
 *   import { withRemediation } from '@develler/remediation-agent/nextjs'
 *
 *   export const GET = withRemediation(async (req) => {
 *     return Response.json({ email: 'user@example.com', ssn: '123-45-6789' })
 *   })
 */
export function withRemediation(handler: AppRouterHandler): AppRouterHandler {
  return async (req: NextRequest, ctx?: unknown): Promise<Response> => {
    // Get the original response first.
    const original = await handler(req, ctx);

    let connection: ConnectionConfig;
    try {
      connection = loadConnection();
    } catch {
      return original;
    }

    try {
      if (await isCircuitOpen(connection.client_id)) return original;

      const redis        = createUpstashAdapter();
      const fetcher      = new InstructionFetcher(redis, connection);
      const instructions = await fetcher.getActive();

      if (!instructions.hasMaskRules()) return original;

      // Only intercept JSON responses.
      const contentType = original.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) return original;

      const body    = await original.json() as unknown;

      // MaskingEngine lives in node:crypto land — import dynamically so the
      // module graph doesn't pull it into Edge Runtime.
      const { MaskingEngine } = await import('../services/MaskingEngine.js');
      const masker  = new MaskingEngine();
      const masked  = masker.apply(body, instructions.maskRules());

      // Reconstruct the response preserving status + all original headers.
      const maskedRes = Response.json(masked, {
        status:  original.status,
        headers: original.headers,
      });

      return maskedRes;

    } catch {
      // On any failure return the original unmasked response and let the
      // circuit breaker handle repeated failures (Express agent behaviour).
      return original;
    }
  };
}

// ── 3. handleRemediationWebhook ───────────────────────────────────────────────

/**
 * Next.js App Router POST handler for the webhook endpoint.
 * Register it as:
 *
 *   // app/api/remediation/v1/webhook/route.ts
 *   import { handleRemediationWebhook } from '@develler/remediation-agent/nextjs'
 *   export const POST = handleRemediationWebhook
 *
 * Runs in Node.js runtime. Add this to the file if needed:
 *   export const runtime = 'nodejs'
 */
export async function handleRemediationWebhook(req: NextRequest): Promise<Response> {
  let connection: ConnectionConfig;
  try {
    connection = loadConnection();
  } catch (err) {
    return Response.json({ error: 'Agent not configured.' }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const envelope = body as WireEnvelope;

  // Verify HMAC using Node.js crypto (this route always runs in Node.js).
  try {
    const { createHmac, timingSafeEqual } = await import('node:crypto');

    if (envelope.client_id !== connection.client_id) {
      return Response.json({ error: 'client_id mismatch.' }, { status: 401 });
    }

    const payload   = (envelope.payload ?? {}) as Record<string, unknown>;
    const canonical = [
      String(envelope.protocol_version ?? ''),
      String(envelope.message_id       ?? ''),
      String(envelope.message_type     ?? ''),
      String(envelope.client_id        ?? ''),
      String(envelope.issued_at        ?? ''),
      String(envelope.nonce            ?? ''),
      Buffer.from(JSON.stringify(sortKeysDeep(payload))).toString('base64url'),
    ].join('.');

    const expected    = createHmac('sha256', connection.token).update(canonical).digest('hex');
    const received    = String(envelope.hmac_sha256 ?? '').toLowerCase();
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(received);

    if (
      expectedBuf.length !== receivedBuf.length ||
      !timingSafeEqual(expectedBuf, receivedBuf)
    ) {
      return Response.json({ error: 'HMAC verification failed.' }, { status: 401 });
    }

    // Nonce deduplication.
    const redis    = createUpstashAdapter();
    const nonceKey = `remediation:nonce:${connection.client_id}:${envelope.nonce}`;
    const isNew    = await redis.setNx(nonceKey, '1', 300);

    if (!isNew) {
      return Response.json({ error: 'Replayed nonce.' }, { status: 409 });
    }

    // Cache the instruction.
    const instruction = RuntimeInstruction.fromWirePayload(
      envelope.payload as WireRuntimeInstructionPayload,
    );

    const fetcher = new InstructionFetcher(redis, connection);
    // Write directly to the cache by calling getActive (which seeds the cache)
    // and then store — reuse the same key strategy.
    const ttl = Math.max(1, instruction.expiresAt - Math.floor(Date.now() / 1000));
    const key = `remediation:instruction:${connection.client_id}:${instruction.instructionId}`;
    await redis.set(key, JSON.stringify(instruction.toJSON()), ttl);
    await redis.sadd(`remediation:active:${connection.client_id}`, [instruction.instructionId]);

    void fetcher; // fetcher created above to keep constructor signature stable

    return Response.json({ status: 'accepted' });

  } catch (err) {
    return Response.json(
      { error: 'Internal error processing instruction.' },
      { status: 500 },
    );
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
