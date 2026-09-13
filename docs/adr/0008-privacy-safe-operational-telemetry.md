# ADR 0008: Privacy-safe operational telemetry

Status: accepted

## Context

Financial commands need traceable failures and operators need enough information to correlate an API response with service telemetry. Request bodies, authorization headers, identity evidence, payout destinations, provider credentials, and exception messages can contain secrets or customer data. Sending those values to logs or an external error tracker would create another sensitive data store.

## Decision

Pino produces structured JSON logs with a fixed service binding and ISO timestamps. Every completed request records its server-issued request ID, OpenAPI operation ID, status, and elapsed time. Redaction removes authorization and cookie headers, request bodies, response cookies, and recursively named password, secret, and token fields.

Unexpected server failures may be reported to Sentry only when `ERROR_TRACKING_DSN` is configured with HTTPS. The adapter disables Sentry's default integrations and default PII collection. Before transmission it removes request, user, breadcrumb, and extra-data fields. It replaces the exception message with a constant while retaining the exception type and source frames. The only attached context is the request ID, operation ID, and stable error code.

Expected client errors are returned through the typed API error contract and are not sent to error tracking. Service-unavailable failures are reported because they require operational attention. Shutdown makes a bounded attempt to flush queued reports.

## Consequences

Operators can join API responses, JSON logs, and error reports using a request ID without copying customer payloads into telemetry. The error tracker has less diagnostic detail by design; authorized operators use protected audit, reconciliation, and provider systems for deeper investigation. Adding traces, metrics, release identifiers, alert routing, or a replacement provider requires a reviewed adapter change and the same data-minimization rules.
