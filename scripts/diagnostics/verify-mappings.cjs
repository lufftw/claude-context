#!/usr/bin/env node
// Verify (collection name -> repo path) mappings by sampling collection content
// against disk. Used to audit reconcile-snapshot.ps1 output, since the
// snake_case→kebab-case heuristic is wrong when repos have been renamed.
//
// Run from claude-context repo root:  node scripts/diagnostics/verify-mappings.cjs

const http = require('http');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.MILVUS_TOKEN || 'root:zzrNgGZ4xwLMHkQN368b';
const HOST = process.env.MILVUS_HOST || '127.0.0.1';
const PORT = parseInt(process.env.MILVUS_PORT || '19530', 10);

function query(coll) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ collectionName: coll, dbName: 'default', limit: 8, outputFields: ['relativePath'] });
        const req = http.request({
            host: HOST, port: PORT, path: '/v2/vectordb/entities/query', method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN, 'Content-Length': Buffer.byteLength(body) }
        }, (r) => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => { try { resolve(JSON.parse(d).data || []); } catch (e) { resolve([]); } });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

const mappings = [
    ['mcp_services_own',              'E:/Developer/lufftw/repo/mcp-services'],
    ['milvus_services_own',           'E:/Developer/lufftw/repo/milvus-services'],
    ['event_platform_infra_own',      'E:/Developer/lufftw/repo/event-platform-infra'],
    ['event_chat_service_own',        'E:/Developer/lufftw/repo/event-chat-service'],
    ['event_crawler_worker_own',      'E:/Developer/lufftw/repo/event-crawler-worker'],
    ['event_model_worker_own',        'E:/Developer/lufftw/repo/event-model-worker'],
    ['gpu_coordinator_own',           'E:/Developer/lufftw/repo/gpu-coordinator'],
    ['taiwan_address_normalizer_own', 'E:/Developer/lufftw/repo/taiwan-address-normalizer'],
    ['poi_crawler_worker_own',        'E:/Developer/lufftw/repo/poi-data-layer-crawler-worker'],
];

(async () => {
    for (const [coll, repoPath] of mappings) {
        const samples = await query(coll);
        if (!samples.length) { console.log(`  ⚠ ${coll.padEnd(32)} -> query returned no rows`); continue; }
        let hits = 0;
        for (const row of samples) {
            const norm = row.relativePath.split('\\').join('/');
            if (fs.existsSync(path.join(repoPath, norm))) hits++;
        }
        const verdict = hits === samples.length ? '✅ MATCH    '
                       : hits > 0              ? '⚠ PARTIAL  '
                                               : '❌ MISMATCH ';
        console.log(`  ${verdict} ${coll.padEnd(32)} -> ${repoPath} (${hits}/${samples.length} sample files exist)`);
    }
})();
