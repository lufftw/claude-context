# Bug fix — 2026-11-04: RabbitMQ heartbeat setting was silently ignored

**Affected:** every fork release with the RabbitMQ embedding provider, up to `0.1.15-lufftw.1`.
**Fixed in:** `0.1.15-lufftw.2` (`packages/core/src/embedding/rabbitmq-embedding.ts`).

## Symptom

None visible in normal operation. Long idle periods between embedding batches could still drop
the AMQP connection through a NAT, firewall or load balancer that closes idle TCP sessions. The
provider then reconnects on the next request instead of keeping a live connection.

## Root cause

`RabbitMQEmbedding` passed `{ heartbeat: 60 }` as amqplib **socket options**. amqplib reads
`heartbeat` only from the URL query (`amqp://…/vhost?heartbeat=60`) or from a `Connect` object
(`lib/connect.js`). The value was never applied:

| amqplib | Behaviour with the ignored option |
|---|---|
| 1.0.3 (used until now) | Client proposed heartbeat `0`, so **heartbeats were disabled** |
| 2.x | Client accepts the server's proposal (RabbitMQ default 60 s) |

The defect surfaced when amqplib 2.2.1 replaced `@types/amqplib`: its bundled types reject
`heartbeat` in socket options, and the build failed.

## Fix

`withHeartbeat(url, seconds)` adds `heartbeat=<seconds>` to the connection URL's query unless the
URL already sets one. An explicit `?heartbeat=` in `RABBITMQ_INFERENCE_URL` therefore still wins.
Credentials, vhost and other query parameters are preserved. Covered by
`src/embedding/rabbitmq-heartbeat.test.ts`.

## Operational note

After upgrading, connections negotiate a 60 s heartbeat (or the URL value). No configuration
change is required.
