#!/usr/bin/env node
// Static feature-regression: verifies fork-distinctive markers survive in source.
// No live AMQP/Milvus calls. Live behavior is exercised in B3.4 e2e.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const fails = { count: 0 };
const must = (label, ok) => {
  if (!ok) { console.error(`[fregr] FAIL ${label}`); fails.count++; }
  else console.error(`[fregr] ok   ${label}`);
};
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// 1. snapshot.ts — proper-lockfile, ghost-resurrection guard, CLAUDE_CONTEXT_HOME read.
const snapTs = read('packages/mcp/src/snapshot.ts');
must('snapshot.ts uses proper-lockfile', /proper-lockfile/.test(snapTs));
must('snapshot.ts has removedCodebases ghost guard', /removedCodebases/.test(snapTs));
must('snapshot.ts reads CLAUDE_CONTEXT_HOME', /CLAUDE_CONTEXT_HOME/.test(snapTs));

// 2. env-manager.ts — AsyncLocalStorage, runWithProject, setProjectPath.
const envTs = read('packages/core/src/utils/env-manager.ts');
must('env-manager.ts has AsyncLocalStorage', /AsyncLocalStorage/.test(envTs));
must('env-manager.ts has runWithProject', /runWithProject\s*\(/.test(envTs));
must('env-manager.ts has setProjectPath', /setProjectPath\s*\(/.test(envTs));

// 3. context.ts — multi-collection methods, dual-write tracking, ≥4 runWithProject occurrences.
const ctxTs = read('packages/core/src/context.ts');
must('context.ts has getCollectionName', /getCollectionName\s*\(/.test(ctxTs));
must('context.ts has getSharedCollectionName', /getSharedCollectionName\s*\(/.test(ctxTs));
must('context.ts has getWritableSharedCollectionName', /getWritableSharedCollectionName\s*\(/.test(ctxTs));
must('context.ts has consecutiveBatchErrors', /consecutiveBatchErrors/.test(ctxTs));
const rwpHits = (ctxTs.match(/runWithProject/g) ?? []).length;
must(`context.ts has runWithProject occurrences (got ${rwpHits}, need ≥4)`, rwpHits >= 4);

// 4. RabbitMQEmbedding presence + 4096 default + getDimension method (source-grep, no instantiation).
const rmqTs = read('packages/core/src/embedding/rabbitmq-embedding.ts');
must('rabbitmq-embedding.ts present (>1KB)', rmqTs.length > 1000);
must('rabbitmq-embedding.ts default dim 4096', /\b4096\b/.test(rmqTs));
must('rabbitmq-embedding.ts has getDimension', /getDimension\s*\(\s*\)/.test(rmqTs));
const embIdx = read('packages/core/src/embedding/index.ts');
// Match either the lowercase file re-export OR the class name literal.
must('embedding/index.ts exports rabbitmq-embedding', /rabbitmq-embedding|RabbitMQEmbedding/.test(embIdx));

// 5. base-embedding.ts — UTF-16 surrogate guard.
const baseTs = read('packages/core/src/embedding/base-embedding.ts');
must('base-embedding.ts has surrogate guard', /0xD800|0xDBFF|surrogate/i.test(baseTs));

// 6. mcp/src/index.ts — stderr redirect. Default placeholder regex never matches; Task 0.7.8 patches.
const idxTs = read('packages/mcp/src/index.ts');
const STDERR_REGEX = /console\.log\s*=\s*\([^)]*\)\s*=>\s*\{[\s\S]*?process\.stderr\.write/;
must('mcp/src/index.ts redirects to stderr', STDERR_REGEX.test(idxTs));

if (fails.count) { console.error(`[fregr] ${fails.count} FAIL(s)`); process.exit(20); }
console.error('[fregr] OK static feature regressions pass');
process.exit(0);
