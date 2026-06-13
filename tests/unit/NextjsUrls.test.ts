import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNextjsSiteUrl, resolveNextjsWebhookUrl } from '../../src/commands/nextjsUrls.js';

describe('Next.js setup URLs', () => {
  it('builds an absolute webhook URL from the configured production URL', () => {
    const siteUrl = resolveNextjsSiteUrl({
      NEXT_PUBLIC_URL: 'https://example.vercel.app/',
    });

    assert.equal(siteUrl, 'https://example.vercel.app');
    assert.equal(
      resolveNextjsWebhookUrl(siteUrl),
      'https://example.vercel.app/api/remediation/v1/webhook',
    );
  });

  it('uses the Vercel production URL when NEXT_PUBLIC_URL is absent', () => {
    const siteUrl = resolveNextjsSiteUrl({
      VERCEL_PROJECT_PRODUCTION_URL: 'example.com',
    });

    assert.equal(siteUrl, 'https://example.com');
    assert.equal(
      resolveNextjsWebhookUrl(siteUrl),
      'https://example.com/api/remediation/v1/webhook',
    );
  });

  it('falls back to localhost for local setup', () => {
    const siteUrl = resolveNextjsSiteUrl({ PORT: '4000' });

    assert.equal(siteUrl, 'http://localhost:4000');
    assert.equal(
      resolveNextjsWebhookUrl(siteUrl),
      'http://localhost:4000/api/remediation/v1/webhook',
    );
  });
});
