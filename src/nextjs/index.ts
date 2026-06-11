/**
 * @develler/remediation-agent/nextjs
 *
 * Next.js / Vercel entry point for the Develler Remediation Engine agent.
 *
 * Usage:
 *
 *   // middleware.ts (project root) — Edge Runtime
 *   import { createNextjsMiddleware } from '@develler/remediation-agent/nextjs'
 *   export const middleware = createNextjsMiddleware()
 *   export const config = { matcher: '/api/:path*' }
 *
 *   // app/api/users/route.ts — PII masking on a specific route
 *   import { withRemediation } from '@develler/remediation-agent/nextjs'
 *   export const GET = withRemediation(async (req) => {
 *     return Response.json({ email: 'user@example.com' })
 *   })
 *
 *   // app/api/remediation/v1/webhook/route.ts — webhook receiver
 *   import { handleRemediationWebhook } from '@develler/remediation-agent/nextjs'
 *   export const POST = handleRemediationWebhook
 *   export const runtime = 'nodejs'
 *
 * Required environment variables:
 *   REMEDIATION_SAAS_URL        — Your Develler dashboard URL
 *   REMEDIATION_CLIENT_ID       — From `npx @develler/remediation-agent YOUR_KEY`
 *   REMEDIATION_TOKEN           — From `npx @develler/remediation-agent YOUR_KEY`
 *   UPSTASH_REDIS_REST_URL      — From Vercel × Upstash integration
 *   UPSTASH_REDIS_REST_TOKEN    — From Vercel × Upstash integration
 */

export {
  createNextjsMiddleware,
  withRemediation,
  handleRemediationWebhook,
} from './NextjsInterceptor.js';

export type { NextjsMiddlewareConfig } from './NextjsInterceptor.js';
export { UpstashRedisAdapter, createUpstashAdapter } from './UpstashRedisAdapter.js';
export type { UpstashConfig } from './UpstashRedisAdapter.js';
export { InstructionFetcher } from './InstructionFetcher.js';
