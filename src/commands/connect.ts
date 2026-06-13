#!/usr/bin/env node
/**
 * npx remediation-connect
 *
 * Performs the initial handshake with the SaaS, stores the returned
 * client_id, raw token, and channel configuration in
 * .remediation-connection.json at the project root.
 *
 * Safe to re-run — overwrites any existing connection file.
 *
 * Usage:
 *   Add REMEDIATION_SAAS_URL and REMEDIATION_CONNECTION_KEY to your .env, then:
 *   npx remediation-connect
 */

import axios from 'axios';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { ConnectionConfig, HandshakeRequest, HandshakeResponse } from '../types/wireProtocol.js';

const CONNECTION_FILE = join(process.cwd(), '.remediation-connection.json');

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
  const saasUrl       = (process.env['REMEDIATION_SAAS_URL']       ?? '').replace(/\/+$/, '');
  const connectionKey = process.argv[2] || process.env['REMEDIATION_CONNECTION_KEY'] || '';
  const webhookUrl    = process.env['REMEDIATION_WEBHOOK_URL']      ?? null;

  if (!saasUrl || !connectionKey) {
    console.error('ERROR: REMEDIATION_SAAS_URL and REMEDIATION_CONNECTION_KEY must both be set.');
    process.exit(1);
  }

  console.log(`Connecting to: ${saasUrl}`);

  const payload: HandshakeRequest = {
    connection_key:    connectionKey,
    site_url:          process.env['APP_URL'] ?? `http://localhost:${process.env['PORT'] ?? 3000}`,
    site_name:         process.env['APP_NAME'] ?? null,
    language_runtime:  'node',
    runtime_version:   process.version,
    framework:         process.env['REMEDIATION_FRAMEWORK'] ?? 'express',
    framework_version: process.env['REMEDIATION_FRAMEWORK_VERSION'] ?? null,
    agent_version:     process.env['npm_package_version'] ?? null,
    environment:       ((process.env['NODE_ENV'] === 'development' ? 'local' : (process.env['NODE_ENV'] ?? 'production'))) as 'local' | 'staging' | 'production',
    capabilities: {
      mode_a_ast:         false,
      mode_b_interceptor: true,
      redis_available:    await checkRedis(),
      git_access:         false,
    },
    webhook_url: webhookUrl,
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
    console.error(`ERROR: Connection request failed — ${message}`);
    process.exit(1);
  }

  if (response.status !== 'accepted') {
    console.error('ERROR: SaaS rejected the handshake. Check your REMEDIATION_CONNECTION_KEY.');
    process.exit(1);
  }

  const config: ConnectionConfig = {
    client_id:            response.client_id,
    token:                response.token,
    saas_url:             saasUrl,
    channel_type:         response.instruction_channel.type,
    poll_url:             response.instruction_channel.poll_url,
    poll_interval_seconds: response.instruction_channel.poll_interval_seconds,
    connected_at:         new Date().toISOString(),
  };

  writeFileSync(CONNECTION_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });

  console.log(`Connected successfully.`);
  console.log(`  client_id : ${config.client_id}`);
  console.log(`  channel   : ${config.channel_type}`);
  console.log(`  config    : ${CONNECTION_FILE}`);
  console.log('');
  console.log('Add .remediation-connection.json to your .gitignore.');
}

async function checkRedis(): Promise<boolean> {
  const redisUrl = process.env['REDIS_URL'] ?? process.env['REMEDIATION_REDIS_URL'] ?? null;
  if (!redisUrl) return false;
  try {
    const { default: Redis } = await import('ioredis');
    const client = new Redis(redisUrl, { lazyConnect: true, connectTimeout: 3000 });
    await client.connect();
    await client.ping();
    await client.disconnect();
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
