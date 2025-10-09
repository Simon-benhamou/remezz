# WebSocket Reconnect & Throttling Guide

This guide documents the runtime expectations for the real-time transport between the frontend and backend. It highlights the new rate-limit enforcement, token lifecycle, and how the client should behave when throttled.

## REST rate limits

The backend now enforces rate limits on critical monitoring surfaces:

| Scope | Dimensions | Default window | Default caps |
|-------|------------|----------------|--------------|
| Agent REST (`/api/agent/*`) | IP & API key | 60 seconds | 60 IP hits / 120 key hits |
| Monitor REST (`/api/monitor/*`) | IP & API key | 60 seconds | 120 IP hits / 240 key hits |

When a client exceeds a quota, the API replies with HTTP `429` and a JSON payload:

```json
{
  "error": "rate_limit_exceeded",
  "code": "rate_limit.agent.ip",
  "message": "Agent API rate limit exceeded for your IP address.",
  "retryAfterSec": 15
}
```

Every breach is logged through `recordOpsEvent` with the offending identifier, allowing Ops dashboards to surface the incident.

### Client expectations

* Respect the `retryAfterSec` hint before retrying.
* Treat any `rate_limit.*` error as a signal to pause polling and fall back to cached data.

## WebSocket authentication lifecycle

* Clients must request a short-lived JWT via `POST /api/auth/ws-token`. The response returns `token`, `expiresAt`, and `expiresIn` seconds.
* The WS handshake now sends `{ type: "hello", token }`. On success the server replies `{ type: "hello_ok", expiresAt }`.
* The server tracks expiry per connection. Any message received after expiry emits `{ type: "error", code: "ws.auth.expired" }` and halts further processing until a refresh arrives.
* Refreshes are performed in-band via `{ type: "refresh", token }` using a newly minted JWT. A successful refresh yields `{ type: "refresh_ok", expiresAt }` without tearing down the socket.
* Invalid or expired refresh attempts return `{ type: "error", code: "ws.auth.invalid" | "ws.auth.expired" }`. The connection stays open so the client can back off and retry with a fresh credential.

### Recommended client loop

1. Fetch a WS token before connecting.
2. Connect to `/ws`, send `hello` with the token, then await `hello_ok`.
3. Schedule a refresh ~10 seconds before the advertised expiry. On refresh failure, back off using the `retryAfterSec` hint from the REST issuer, then retry.
4. If the socket emits `ws.auth.*` or `rate_limit.*` errors, treat them as soft failures: pause outbound messages, request a fresh token, and reconnect with exponential backoff (the frontend now does this automatically).

## Operational logging

The backend annotates ops events for:

* `ws_token_issued` – successful token mint with identity and expiry metadata.
* `ws_token_denied` – unauthorized token requests.
* `ws_hello_invalid` / `ws_hello_expired` – rejected handshakes.
* `ws_token_expired` – runtime expirations prompting a refresh.
* `ws_token_refreshed` – successful in-band refreshes.

These events flow into the monitoring dashboards so that operators can trace reconnect storms or abusive clients.
