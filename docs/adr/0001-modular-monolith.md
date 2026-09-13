# ADR 0001: Start with a modular monolith

Status: accepted.

Use a TypeScript/Fastify modular monolith with PostgreSQL transactions and explicit domain/provider interfaces. This keeps cross-domain invariants enforceable without premature distributed transactions. Extract matching or other services only after latency, isolation, scaling, deployment, or ownership evidence justifies the cost.

Microservices per domain were rejected because the current workload does not justify additional failure modes. The consequence is a need for strict module boundaries and measurement before extraction.
