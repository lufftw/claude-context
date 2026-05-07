#!/usr/bin/env node
// Live Qwen3 worker probe via the fork's RabbitMQEmbedding class.
// Uses production code path (not a hand-rolled AMQP envelope) so probe correctness tracks production.
// Asserts: vector length 4096, L2 norm in [0.99, 1.01].
//
// Required env (real credentials, NOT smoke):
//   RABBITMQ_INFERENCE_URL
//   RABBITMQ_EMBEDDING_QUEUE  (production queue, captured at Task 0.7.0f)
//
// Constructor / method signature is verified at Task 0.7.0f against fork source. Adjust call shape
// here if 0.7.0f introspection reveals divergence (e.g., positional args or different method name).
// Default method called: emb.embedBatch(['test']). Fallback: emb.embed(['test']) or emb.embed('test').

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const url = process.env.RABBITMQ_INFERENCE_URL;
const queue = process.env.RABBITMQ_EMBEDDING_QUEUE;
if (!url) { console.error('[probe] RABBITMQ_INFERENCE_URL required'); process.exit(2); }
if (!queue) { console.error('[probe] RABBITMQ_EMBEDDING_QUEUE required'); process.exit(2); }
if (url.includes('127.0.0.1:1') || url.includes('noop')) { console.error('[probe] REFUSING noop URL'); process.exit(3); }

const rmqPath = path.resolve(repoRoot, 'packages/core/dist/embedding/rabbitmq-embedding.js');
const mod = await import(rmqPath);
const RabbitMQEmbedding = mod.RabbitMQEmbedding ?? mod.default?.RabbitMQEmbedding;
if (!RabbitMQEmbedding) { console.error('[probe] RabbitMQEmbedding not exported from', rmqPath); process.exit(4); }

let emb;
try {
  emb = new RabbitMQEmbedding({
    url,
    queue,
    model: process.env.RABBITMQ_EMBEDDING_MODEL ?? 'qwen3-embedding-8b',
    dimension: 4096
  });
} catch (e) {
  console.error('[probe] FAIL: RabbitMQEmbedding construction:', e.message);
  process.exit(4);
}

let exitCode = 0;
try {
  let raw;
  if (typeof emb.embedBatch === 'function') {
    raw = await emb.embedBatch(['test']);
  } else if (typeof emb.embed === 'function') {
    const r = await emb.embed(['test']);
    raw = Array.isArray(r) ? r : [r];
  } else {
    console.error('[probe] FAIL: RabbitMQEmbedding has neither embedBatch nor embed method');
    exitCode = 5; throw new Error('no embed method');
  }

  if (!Array.isArray(raw) || raw.length !== 1) { console.error('[probe] FAIL: embed result not 1-element array', raw); exitCode = 5; throw new Error('bad result shape'); }
  const item = raw[0];
  // Possible shapes: plain array, { vector }, Float32Array.
  let vec;
  if (Array.isArray(item)) vec = item;
  else if (item && Array.isArray(item.vector)) vec = item.vector;
  else if (item && typeof item.length === 'number') vec = Array.from(item);
  else { console.error('[probe] FAIL: cannot extract vector from item', item); exitCode = 6; throw new Error('cannot extract vector'); }

  if (vec.length !== 4096) { console.error(`[probe] FAIL: dim=${vec.length} expected 4096`); exitCode = 7; throw new Error('bad dim'); }
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  if (norm < 0.99 || norm > 1.01) { console.error(`[probe] FAIL: L2=${norm.toFixed(4)} outside [0.99,1.01]`); exitCode = 8; throw new Error('bad norm'); }

  console.error(`[probe] OK dim=${vec.length} L2=${norm.toFixed(4)} queue=${queue}`);
} catch (e) {
  if (exitCode === 0) { console.error(`[probe] ERROR ${e.stack ?? e.message}`); exitCode = 1; }
} finally {
  if (emb && typeof emb.close === 'function') {
    try { await emb.close(); } catch {}
  }
  process.exit(exitCode);
}
