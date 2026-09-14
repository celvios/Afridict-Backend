import { stdTimeFunctions, type LoggerOptions } from 'pino';

const sensitivePaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body',
  'res.headers.set-cookie',
  '*.password',
  '*.secret',
  '*.token',
];

export function loggingConfiguration(enabled: boolean): LoggerOptions | false {
  if (!enabled) return false;
  return {
    level: 'info',
    base: { service: 'afridict-backend' },
    timestamp: stdTimeFunctions.isoTime,
    formatters: { level: label => ({ level: label }) },
    redact: { paths: sensitivePaths, censor: '[REDACTED]' },
  };
}
