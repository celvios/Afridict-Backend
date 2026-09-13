# ADR 0002: Federate password and Google authentication through OIDC

Status: accepted direction; identity provider selection pending.

One OIDC provider will own email/password credentials, recovery, MFA, sessions, and Google federation. Afridict verifies issuer, audience, signature, expiry, and immutable subject claims, then applies server-owned roles and capabilities. Google email is not an account key.

Local password storage and direct email-based account linking were rejected because they would create competing identity authorities and unsafe takeover paths. Authentication methods remain disabled until the provider contract and operational controls are approved.
