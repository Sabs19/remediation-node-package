import { createLogger, format, transports } from 'winston';
import { join } from 'path';

/**
 * Dedicated logger for the Remediation Engine agent.
 * Writes to a separate file so agent logs never mix into the host app's log stream.
 * No PII-adjacent data is ever logged — only instruction IDs and error messages.
 */
export const logger = createLogger({
  level: process.env['REMEDIATION_LOG_LEVEL'] ?? 'error',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json(),
  ),
  defaultMeta: { service: 'remediation-agent' },
  transports: [
    new transports.File({
      filename: join(process.cwd(), 'logs', 'remediation.log'),
      maxsize:  10 * 1024 * 1024,  // 10 MB
      maxFiles: 5,
      tailable: true,
    }),
  ],
  // Silent by default in test environments.
  silent: process.env['NODE_ENV'] === 'test',
});
