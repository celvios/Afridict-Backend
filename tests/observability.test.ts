import { describe, expect, it } from 'vitest';
import { sanitizedError } from '../src/platform/error-reporting.js';
import { loggingConfiguration } from '../src/platform/logging.js';

describe('operational telemetry boundaries', () => {
  it('emits JSON logs with service identity and recursive secret redaction', () => {
    const options = loggingConfiguration(true);
    expect(options).toMatchObject({ level: 'info', base: { service: 'afridict-backend' },
      redact: { censor: '[REDACTED]' } });
    expect(options && options.redact).toMatchObject({ paths: expect.arrayContaining([
      'req.headers.authorization', 'req.body', '*.password', '*.secret', '*.token',
    ]) });
    expect(loggingConfiguration(false)).toBe(false);
  });

  it('removes exception messages while preserving the failure type and source frames', () => {
    const original = new Error('database row contained private@example.com');
    const sanitized = sanitizedError(original);
    expect(sanitized.name).toBe('Error');
    expect(sanitized.message).toBe('Unexpected backend failure');
    expect(sanitized.stack).not.toContain('private@example.com');
    expect(sanitized.stack).toContain('observability.test.ts');
  });
});
