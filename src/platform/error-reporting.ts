import * as Sentry from '@sentry/node';
import type { Config } from './config.js';

export interface ErrorContext {
  requestId: string;
  operation?: string;
  code?: string;
}

export interface ErrorReporter {
  capture(error: unknown, context: ErrorContext): void;
  flush(timeout: number): Promise<boolean>;
}

export function sanitizedError(error: unknown) {
  const safe = new Error('Unexpected backend failure');
  safe.name = error instanceof Error ? error.name : 'UnknownError';
  if (error instanceof Error && error.stack) {
    const frames = error.stack.split('\n').slice(1);
    safe.stack = [`${safe.name}: ${safe.message}`, ...frames].join('\n');
  }
  return safe;
}

const disabledReporter: ErrorReporter = {
  capture: () => {},
  flush: async () => true,
};

export function createErrorReporter(cfg: Config): ErrorReporter {
  if (!cfg.errorTrackingDsn) return disabledReporter;
  Sentry.initWithoutDefaultIntegrations({
    dsn: cfg.errorTrackingDsn,
    environment: cfg.environment,
    sendDefaultPii: false,
    beforeSend(event) {
      delete event.request;
      delete event.user;
      delete event.breadcrumbs;
      delete event.extra;
      return event;
    },
  });
  return {
    capture(error, context) {
      Sentry.withScope(scope => {
        scope.setContext('failure', {
          request_id: context.requestId,
          operation: context.operation ?? 'unknown',
          code: context.code ?? 'INTERNAL_ERROR',
        });
        Sentry.captureException(sanitizedError(error));
      });
    },
    flush: timeout => Sentry.flush(timeout),
  };
}
