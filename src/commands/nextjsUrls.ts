const WEBHOOK_PATH = '/api/remediation/v1/webhook';

export function resolveNextjsSiteUrl(env: NodeJS.ProcessEnv): string {
  const configuredUrl = env['NEXT_PUBLIC_URL'] ?? env['APP_URL'];
  if (configuredUrl) {
    return configuredUrl.replace(/\/+$/, '');
  }

  // VERCEL_URL is deployment-specific (changes every deploy) — don't use it.
  const vercelUrl = env['VERCEL_PROJECT_PRODUCTION_URL'];
  if (vercelUrl) {
    return `https://${vercelUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  }

  return `http://localhost:${env['PORT'] ?? '3000'}`;
}

export function resolveNextjsWebhookUrl(siteUrl: string): string {
  return new URL(WEBHOOK_PATH, `${siteUrl}/`).toString();
}
