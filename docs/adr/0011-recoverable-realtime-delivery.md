# ADR 0011: Recoverable realtime market delivery

Status: accepted and implemented for isolated synthetic execution. Production scale and activation are not approved.

## Context

Consumer clients need low-latency order-book, execution, position, and resolution updates. A WebSocket is not itself a source of truth: connections disconnect, frames can be delayed, and slow clients can exhaust server memory. Browser WebSocket APIs also cannot reliably attach the normal bearer authorization header. Putting bearer tokens in URLs would expose credentials to logs and infrastructure.

## Decision

An authenticated HTTP call issues a cryptographically random, one-use ticket that expires after 60 seconds. Only its SHA-256 digest is stored. The browser opens `/v1/realtime` and sends the ticket in its first frame; unauthenticated sockets have a five-second deadline. Ticket consumption is transactional, so concurrent reuse has one winner.

Each subscription carries a published market ID, the last contiguous market sequence applied by the client, and up to 20 outcomes whose aggregate books should be refreshed. The server replays the existing append-only `clob_events` log strictly after that cursor. It sends public market events in order, then authoritative order-book and caller-owned position snapshots tied to the resulting sequence. Resolution, AMM, and RFQ executions use the same market sequence. A cursor ahead of the server is rejected so the client cannot silently skip history.

Delivery polls the durable event log in bounded pages. The connection closes when its outbound buffer exceeds one MiB; the client reconnects from its last applied sequence. The HTTP snapshot and event endpoints remain available for initial state and recovery. `api/asyncapi.json` is the protocol contract; OpenAPI documents ticket issuance.

## Consequences

Connection loss does not lose canonical state, and private positions are delivered only after account authentication. Servers can restart without maintaining an in-memory replay log. Polling adds database reads and sub-second latency, so production scale requires measured connection limits, shared change notification, load testing, and fleet-wide capacity controls before activation.

