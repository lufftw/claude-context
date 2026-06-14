#!/usr/bin/env node
// ============================================================================
// Gate G1 — LIVE 0.6B worker health probe (Phase 6, dual-embedding)
// ----------------------------------------------------------------------------
// capture == verify: this drives the REAL compiled `RabbitMQEmbedding` from the
// worktree dist (the exact production code path), so probe correctness tracks
// production. It does NOT hand-roll an AMQP envelope.
//
// What it does:
//   - Constructs RabbitMQEmbedding for the SECONDARY model:
//       queue=embedding.qwen3-0.6b, dimension=1024, priority=8 (TEST priority).
//   - Calls embed('dual-embedding 0.6b health probe')  (ONE tiny test embed).
//   - Asserts (parsed, not substring):
//       * vector length === 1024
//       * L2 norm ∈ (0.5, 2.0)
//   - Prints parsed length + norm as JSON.
//   - Exit 0 on pass, non-zero on fail.
//
// Also runs the SAME one-shot against the 8B queue (dim 4096) as a sanity
// control. The 8B control is NON-FATAL: if it lags/fails it is reported but
// does not change the exit code (G1 is about the 0.6B worker).
//
// SAFETY: priority 8 = TEST priority. Shared queues are NEVER purged/deleted.
// WAIT-class lag is tolerated by the provider's own retry-via-republish; we use
// a patient-but-bounded per-attempt timeout so genuine lag is retried, not
// misclassified as a failure.
// ============================================================================

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..'); // -> worktree root
const toFileUrl = (p) => (p.startsWith('file:') ? p : pathToFileURL(p).href);

// --- Credentials (this Windows box) -----------------------------------------
const URL =
  process.env.RABBITMQ_INFERENCE_URL ||
  'amqp://crawler:4MizIwuQ1wbSOL5vXh3WMBKU@127.0.0.1:5672/inference';

if (URL.includes('127.0.0.1:1)') || URL.includes('noop')) {
  console.error('[G1] REFUSING noop/placeholder URL');
  process.exit(3);
}

// Per-attempt liveness timeout. Patient enough to ride out WAIT-class lag on a
// busy shared worker, but bounded so a dead worker fails in reasonable time.
// With maxRetries=2 the worst case is 3 * 120s = 360s, well under the broker's
// 2h consumer_timeout, so a slow worker is never starved by us.
const PER_ATTEMPT_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;
const TEST_PRIORITY = 8; // shared-infra TEST priority — never escalate

// --- Load the REAL compiled provider from the worktree dist -----------------
const rmqPath = path.resolve(
  repoRoot,
  'packages/core/dist/embedding/rabbitmq-embedding.js'
);
const mod = await import(toFileUrl(rmqPath));
const RabbitMQEmbedding = mod.RabbitMQEmbedding ?? mod.default?.RabbitMQEmbedding;
if (!RabbitMQEmbedding) {
  console.error('[G1] RabbitMQEmbedding not exported from', rmqPath);
  process.exit(4);
}

/**
 * Drive one tiny live embed through the real provider and parse the result.
 * Returns { ok, length, norm, detail }.
 */
async function probe({ label, queue, dimension, modelName }) {
  let emb;
  try {
    emb = new RabbitMQEmbedding({
      url: URL,
      queue,
      modelName,
      dimension,
      priority: TEST_PRIORITY,
      timeoutMs: PER_ATTEMPT_TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
      source: 'phase6-G1-worker-health',
    });
  } catch (e) {
    return { ok: false, length: null, norm: null, detail: `construct: ${e.message}` };
  }

  try {
    const t0 = Date.now();
    const res = await emb.embed(`dual-embedding ${label} health probe`);
    const elapsedMs = Date.now() - t0;

    // EmbeddingVector shape: { vector: number[], dimension: number }
    let vec;
    if (res && Array.isArray(res.vector)) vec = res.vector;
    else if (Array.isArray(res)) vec = res;
    else if (res && typeof res.length === 'number') vec = Array.from(res);
    else return { ok: false, length: null, norm: null, detail: 'cannot extract vector from result' };

    const length = vec.length; // parsed integer, NOT substring
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));

    const lengthOk = length === dimension;
    const normOk = norm > 0.5 && norm < 2.0;

    return {
      ok: lengthOk && normOk,
      length,
      norm,
      elapsedMs,
      lengthOk,
      normOk,
      detail: lengthOk && normOk
        ? 'pass'
        : `assert fail: length===${dimension}? ${lengthOk}; norm∈(0.5,2.0)? ${normOk}`,
    };
  } catch (e) {
    // Provider already distinguishes WAIT vs REAL and retries WAIT internally.
    // If we land here after retries are exhausted, surface the tagged reason.
    const reason = e && e.embedReason ? e.embedReason : 'unknown';
    return { ok: false, length: null, norm: null, detail: `embed error [${reason}]: ${e.message}` };
  } finally {
    if (emb && typeof emb.close === 'function') {
      try { await emb.close(); } catch {}
    }
  }
}

let exitCode = 0;

// --- Gate G1: 0.6B worker (the actual gate) ---------------------------------
const g1 = await probe({
  label: '0.6b',
  queue: 'embedding.qwen3-0.6b',
  dimension: 1024,
  modelName: process.env.RABBITMQ_EMBEDDING_MODEL_0P6B ?? 'qwen3-embedding-0.6b',
});

if (!g1.ok) exitCode = 1;

// --- Sanity control: 8B worker (NON-FATAL) ----------------------------------
const ctrl = await probe({
  label: '8b',
  queue: 'embedding.qwen3-8b',
  dimension: 4096,
  modelName: process.env.RABBITMQ_EMBEDDING_MODEL ?? 'qwen3-embedding-8b',
});

const report = {
  gate: 'G1-worker-health',
  testPriority: TEST_PRIORITY,
  perAttemptTimeoutMs: PER_ATTEMPT_TIMEOUT_MS,
  maxRetries: MAX_RETRIES,
  primary_0p6b: {
    queue: 'embedding.qwen3-0.6b',
    expectedDim: 1024,
    parsedLength: g1.length,
    l2Norm: g1.norm == null ? null : Number(g1.norm.toFixed(6)),
    lengthOk: g1.lengthOk ?? false,
    normOk: g1.normOk ?? false,
    elapsedMs: g1.elapsedMs ?? null,
    pass: g1.ok,
    detail: g1.detail,
  },
  control_8b: {
    queue: 'embedding.qwen3-8b',
    expectedDim: 4096,
    parsedLength: ctrl.length,
    l2Norm: ctrl.norm == null ? null : Number(ctrl.norm.toFixed(6)),
    lengthOk: ctrl.lengthOk ?? false,
    normOk: ctrl.normOk ?? false,
    elapsedMs: ctrl.elapsedMs ?? null,
    pass: ctrl.ok,
    detail: ctrl.detail,
    note: 'non-fatal sanity control — does not affect exit code',
  },
  result: exitCode === 0 ? 'PASS' : 'FAIL',
};

// JSON on stdout so it is machine-parseable; human note on stderr.
console.log(JSON.stringify(report, null, 2));
console.error(`[G1] ${report.result} (exit ${exitCode})`);
process.exit(exitCode);
