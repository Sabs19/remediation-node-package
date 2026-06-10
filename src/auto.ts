/**
 * Auto-instrumentation entry point.
 * Activated by NODE_OPTIONS=--require @develler/remediation-agent/auto
 * (written to .env automatically by the setup command).
 *
 * Patches express() so every new app instance gets the remediation
 * middleware attached before any user routes — no code changes needed.
 */

import Module from 'module';
import type { RequestHandler } from 'express';
import { createRemediationMiddleware } from './index.js';

// ── Agent initialisation ─────────────────────────────────────────────────────

let resolvedHandler: RequestHandler | null = null;

createRemediationMiddleware()
  .then(agent => { resolvedHandler = agent.handler(); })
  .catch((err: unknown) => {
    process.stderr.write(
      `[develler] auto-init failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });

// ── Express patch ────────────────────────────────────────────────────────────

const _load = (Module as any)._load as (id: string, ...args: unknown[]) => unknown;
let patched = false;

(Module as any)._load = function load(id: string, ...rest: unknown[]): unknown {
  const mod = _load.apply(this, [id, ...rest]);
  if (!patched && id === 'express') {
    patched = true;
    return wrapExpress(mod);
  }
  return mod;
};

function wrapExpress(express: any): any {
  function patchedExpress(...args: unknown[]): unknown {
    const app = (express as (...a: unknown[]) => any)(...args);
    app.use((req: any, res: any, next: () => void) => {
      if (resolvedHandler) return resolvedHandler(req, res, next as any);
      return next();
    });
    return app;
  }

  Object.setPrototypeOf(patchedExpress, Object.getPrototypeOf(express));
  Object.defineProperties(patchedExpress, Object.getOwnPropertyDescriptors(express));

  return patchedExpress;
}
