#!/usr/bin/env node
/**
 * npx @develler/remediation-agent <connection-key> [--nextjs]
 *
 * One-command setup for the Develler Remediation Agent.
 *
 * Without --nextjs (Express / Node.js):
 *   Installs the package, performs the initial handshake, writes
 *   .remediation-connection.json, and patches NODE_OPTIONS in .env.
 *
 * With --nextjs (Next.js / Vercel):
 *   Performs the handshake, scaffolds middleware.ts and the webhook route,
 *   and prints the env vars to copy into Vercel — no local files to secret-manage.
 */

import { execSync }                          from 'child_process';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname }                     from 'path';
import axios                                 from 'axios';
import type { ConnectionConfig, HandshakeRequest, HandshakeResponse } from '../types/wireProtocol.js';
import { resolveNextjsSiteUrl, resolveNextjsWebhookUrl } from './nextjsUrls.js';

const CONNECTION_FILE = join(process.cwd(), '.remediation-connection.json');

const MIDDLEWARE_TEMPLATE = `import { createNextjsMiddleware } from '@develler/remediation-agent/nextjs'

export const middleware = createNextjsMiddleware()

export const config = {
  matcher: '/api/:path*',
}
`;

const WEBHOOK_TEMPLATE = `import { handleRemediationWebhook } from '@develler/remediation-agent/nextjs'

export const POST = handleRemediationWebhook
export const runtime = 'nodejs'
`;

function loadDotEnv(): void {
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key   = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  loadDotEnv();

  const args          = process.argv.slice(2);
  const isNextjs      = args.includes('--nextjs');
  const connectionKey = args.find((a) => !a.startsWith('--')) ?? process.env['REMEDIATION_CONNECTION_KEY'] ?? '';
  const saasUrl       = (process.env['REMEDIATION_SAAS_URL'] ?? 'https://app.develler.io').replace(/\/+$/, '');

  if (!connectionKey) {
    console.error('');
    console.error('  Usage: npx @develler/remediation-agent <connection-key> [--nextjs]');
    console.error('');
    console.error('  Your connection key is on the Develler dashboard under Setup.');
    console.error('');
    process.exit(1);
  }

  console.log('');
  console.log('  [1/3] Installing @develler/remediation-agent...');

  try {
    execSync('npm install @develler/remediation-agent', { stdio: 'inherit', cwd: process.cwd() });
  } catch {
    console.error('  Failed to run npm install. Make sure npm is available and you are in your project root.');
    process.exit(1);
  }

  console.log('');
  console.log(`  [2/3] Connecting to ${saasUrl}...`);

  const siteUrl = isNextjs
    ? resolveNextjsSiteUrl(process.env)
    : process.env['NEXT_PUBLIC_URL'] ?? process.env['APP_URL'] ?? `http://localhost:${process.env['PORT'] ?? '3000'}`;

  const payload: HandshakeRequest = {
    connection_key:    connectionKey,
    site_url:          siteUrl,
    site_name:         process.env['APP_NAME'] ?? null,
    language_runtime:  'node',
    runtime_version:   process.version,
    framework:         isNextjs ? 'nextjs' : (process.env['REMEDIATION_FRAMEWORK'] ?? 'express'),
    framework_version: process.env['REMEDIATION_FRAMEWORK_VERSION'] ?? null,
    agent_version:     null,
    environment:       (process.env['NODE_ENV'] ?? 'production') as 'local' | 'staging' | 'production',
    capabilities: {
      mode_a_ast:         false,
      mode_b_interceptor: true,
      redis_available:    isNextjs,
      git_access:         false,
    },
    webhook_url: isNextjs ? resolveNextjsWebhookUrl(siteUrl) : null,
  };

  let response: HandshakeResponse;

  try {
    const result = await axios.post<HandshakeResponse>(
      `${saasUrl}/api/remediation/v1/handshake`,
      payload,
      { timeout: 15000 },
    );
    response = result.data;
  } catch (err) {
    const message = axios.isAxiosError(err)
      ? `HTTP ${err.response?.status ?? 'timeout'}: ${JSON.stringify(err.response?.data)}`
      : String(err);
    console.error(`  Connection failed: ${message}`);
    process.exit(1);
  }

  if (response.status !== 'accepted') {
    console.error('  Connection rejected. Check your connection key and try again.');
    process.exit(1);
  }

  const config: ConnectionConfig = {
    client_id:             response.client_id,
    token:                 response.token,
    saas_url:              saasUrl,
    channel_type:          response.instruction_channel.type,
    poll_url:              response.instruction_channel.poll_url,
    poll_interval_seconds: response.instruction_channel.poll_interval_seconds,
    connected_at:          new Date().toISOString(),
  };

  console.log('');

  if (isNextjs) {
    scaffoldNextjs(config, saasUrl);
  } else {
    console.log('  [3/3] Saving connection config...');
    writeFileSync(CONNECTION_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
    patchDotEnv();

    console.log('');
    console.log(`  Connected. client_id: ${String(config.client_id)}`);
    console.log('');
    console.log('  Restart your app and the agent will be active.');
    console.log('  Add .remediation-connection.json to your .gitignore.');
    console.log('');
  }
}

function scaffoldNextjs(config: ConnectionConfig, saasUrl: string): void {
  console.log('  [3/3] Scaffolding files...');
  console.log('');

  const root           = process.cwd();
  const middlewarePath = join(root, 'middleware.ts');
  const webhookDir     = join(root, 'app', 'api', 'remediation', 'v1', 'webhook');
  const webhookPath    = join(webhookDir, 'route.ts');

  // middleware.ts at project root
  if (existsSync(middlewarePath)) {
    console.log('  middleware.ts already exists — skipping (add the import manually if needed).');
  } else {
    writeFileSync(middlewarePath, MIDDLEWARE_TEMPLATE);
    console.log('  Created: middleware.ts');
  }

  // app/api/remediation/v1/webhook/route.ts
  mkdirSync(webhookDir, { recursive: true });
  if (existsSync(webhookPath)) {
    console.log('  app/api/remediation/v1/webhook/route.ts already exists — skipping.');
  } else {
    writeFileSync(webhookPath, WEBHOOK_TEMPLATE);
    console.log('  Created: app/api/remediation/v1/webhook/route.ts');
  }

  // Write credentials to .env.local for local dev
  patchNextjsEnv(config, saasUrl);
  console.log('  Written to .env.local');

  console.log('');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  Add these 3 vars to your production environment:');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('');
  console.log(`  REMEDIATION_SAAS_URL=${saasUrl}`);
  console.log(`  REMEDIATION_CLIENT_ID=${String(config.client_id)}`);
  console.log(`  REMEDIATION_TOKEN=${config.token}`);
  console.log('');
  console.log('  Then commit middleware.ts and the webhook route, and deploy.');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('');
}

function patchNextjsEnv(config: ConnectionConfig, saasUrl: string): void {
  const envPath  = join(process.cwd(), '.env.local');
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

  const vars: Record<string, string> = {
    REMEDIATION_SAAS_URL:  saasUrl,
    REMEDIATION_CLIENT_ID: String(config.client_id),
    REMEDIATION_TOKEN:     config.token,
  };

  let updated = existing.trimEnd();

  for (const [key, value] of Object.entries(vars)) {
    if (new RegExp(`^${key}=`, 'm').test(updated)) {
      updated = updated.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
    } else {
      updated += (updated ? '\n' : '') + `${key}=${value}`;
    }
  }

  writeFileSync(envPath, updated + '\n');
}

function patchDotEnv(): void {
  const envPath  = join(process.cwd(), '.env');
  const flag     = '--require @develler/remediation-agent/auto';
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

  if (existing.includes(flag)) return;

  const nodeOptsMatch = existing.match(/^NODE_OPTIONS=(.*)$/m);
  let updated: string;

  if (nodeOptsMatch) {
    updated = existing.replace(/^NODE_OPTIONS=(.*)$/m, `NODE_OPTIONS=$1 ${flag}`);
  } else {
    updated = existing.trimEnd() + (existing ? '\n' : '') + `NODE_OPTIONS=${flag}\n`;
  }

  writeFileSync(envPath, updated);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Unexpected error: ${msg}`);
  process.exit(1);
});
