import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";

const M8 = "qwen3-embedding-8b";
const M06 = "qwen3-embedding-0.6b";

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-context-mcp-model-"));
    const homeDir = path.join(tempRoot, "home");
    await mkdir(homeDir, { recursive: true });
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    try {
        await run(tempRoot);
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v;
        }
        await rm(tempRoot, { recursive: true, force: true });
    }
}

/** A context stub that knows the two active models and rejects anything else like the real Context. */
function contextStub(extra: Record<string, unknown> = {}) {
    return {
        getActiveModelIds: () => [M8, M06],
        resolveScopedModelIds: (id?: string) => {
            if (!id || !id.trim()) return [M8, M06];
            if (![M8, M06].includes(id.trim())) throw new Error(`Embedding model '${id}' is not active`);
            return [id.trim()];
        },
        isModelReadable: async () => true,
        ...extra,
    };
}

function indexedSnapshot(codebasePath: string): SnapshotManager {
    const snap = new SnapshotManager();
    snap.setCodebaseIndexed(codebasePath, { indexedFiles: 2, totalChunks: 4, status: "completed" });
    snap.setFileCompleteForModel(codebasePath, M8, "a.ts", { complete: true, fileHash: "h8", chunkCount: 2 });
    snap.setFileCompleteForModel(codebasePath, M06, "a.ts", { complete: true, fileHash: "h06", chunkCount: 2 });
    // getIndexedCodebases() reads the snapshot file, so persist what the handlers will look up.
    snap.saveCodebaseSnapshot();
    return snap;
}

test("get_indexing_status: unknown embeddingModel is an error and nothing is synced", async () => {
    await withTempHome(async (root) => {
        const handlers = new ToolHandlers(contextStub() as any, new SnapshotManager());
        let syncs = 0;
        (handlers as any).syncIndexedCodebasesFromCloud = async () => { syncs += 1; };
        const result = await handlers.handleGetIndexingStatus({ path: root, embeddingModel: "bogus" });
        assert.equal(result.isError, true);
        assert.equal(syncs, 0);
    });
});

test("get_indexing_status: embeddingModel limits the readability lines to that model", async () => {
    await withTempHome(async (root) => {
        const codebase = path.join(root, "repo");
        await mkdir(codebase, { recursive: true });
        const handlers = new ToolHandlers(contextStub() as any, indexedSnapshot(codebase));
        (handlers as any).syncIndexedCodebasesFromCloud = async () => {};

        const only06 = await handlers.handleGetIndexingStatus({ path: codebase, embeddingModel: M06 });
        assert.match(only06.content[0].text, /Secondary model 'qwen3-embedding-0\.6b' is readable/);
        assert.doesNotMatch(only06.content[0].text, /Primary model/);

        const only8 = await handlers.handleGetIndexingStatus({ path: codebase, embeddingModel: M8 });
        assert.match(only8.content[0].text, /Primary model 'qwen3-embedding-8b' is readable/);
        assert.doesNotMatch(only8.content[0].text, /Secondary model/);

        const all = await handlers.handleGetIndexingStatus({ path: codebase });
        assert.match(all.content[0].text, /Secondary model/);
        assert.doesNotMatch(all.content[0].text, /Primary model/);
    });
});

test("clear_index: embeddingModel clears one model and keeps the codebase entry and the other ledger", async () => {
    await withTempHome(async (root) => {
        const codebase = path.join(root, "repo");
        await mkdir(codebase, { recursive: true });
        const snap = indexedSnapshot(codebase);
        const calls: unknown[][] = [];
        const ctx = contextStub({ clearIndex: async (...a: unknown[]) => { calls.push(a); } });
        const handlers = new ToolHandlers(ctx as any, snap);

        const result = await handlers.handleClearIndex({ path: codebase, embeddingModel: M06 });

        assert.equal(result.isError, undefined);
        assert.deepEqual(calls, [[codebase, undefined, M06]]);
        assert.equal(snap.getCodebaseStatus(codebase), "indexed");
        assert.equal(snap.getFileLedgerForModel(codebase, M06).size, 0);
        assert.equal(snap.getFileLedgerForModel(codebase, M8).size, 1);
        assert.match(result.content[0].text, /Other models and change tracking were left untouched/);
    });
});

test("clear_index: without embeddingModel the whole codebase is removed (unchanged behaviour)", async () => {
    await withTempHome(async (root) => {
        const codebase = path.join(root, "repo");
        await mkdir(codebase, { recursive: true });
        const snap = indexedSnapshot(codebase);
        const calls: unknown[][] = [];
        const handlers = new ToolHandlers(contextStub({ clearIndex: async (...a: unknown[]) => { calls.push(a); } }) as any, snap);
        const result = await handlers.handleClearIndex({ path: codebase });
        assert.equal(result.isError, undefined);
        assert.deepEqual(calls, [[codebase, undefined, undefined]]);
        assert.equal(snap.getCodebaseStatus(codebase), "not_found");
    });
});

test("clear_index: unknown embeddingModel is rejected before anything is cleared", async () => {
    await withTempHome(async (root) => {
        const codebase = path.join(root, "repo");
        await mkdir(codebase, { recursive: true });
        let cleared = 0;
        const handlers = new ToolHandlers(contextStub({ clearIndex: async () => { cleared += 1; } }) as any, indexedSnapshot(codebase));
        const result = await handlers.handleClearIndex({ path: codebase, embeddingModel: "bogus" });
        assert.equal(result.isError, true);
        assert.equal(cleared, 0);
    });
});

test("index_codebase: embeddingModel refuses force, and refuses a codebase that is not indexed", async () => {
    await withTempHome(async (root) => {
        const codebase = path.join(root, "repo");
        await mkdir(codebase, { recursive: true });
        const handlers = new ToolHandlers(contextStub() as any, indexedSnapshot(codebase));
        (handlers as any).syncIndexedCodebasesFromCloud = async () => {};

        const forced = await handlers.handleIndexCodebase({ path: codebase, embeddingModel: M06, force: true });
        assert.equal(forced.isError, true);
        assert.match(forced.content[0].text, /force=true cannot be combined/);

        const other = path.join(root, "other");
        await mkdir(other, { recursive: true });
        const unindexed = await handlers.handleIndexCodebase({ path: other, embeddingModel: M06 });
        assert.equal(unindexed.isError, true);
        assert.match(unindexed.content[0].text, /not indexed yet/);
    });
});

test("index_codebase: embeddingModel runs a scoped pass that never clears or re-snapshots", async () => {
    await withTempHome(async (root) => {
        const codebase = path.join(root, "repo");
        await mkdir(codebase, { recursive: true });
        const snap = indexedSnapshot(codebase);
        const indexCalls: unknown[][] = [];
        let cleared = 0;
        const ctx = contextStub({
            clearIndex: async () => { cleared += 1; },
            indexCodebase: async (...a: unknown[]) => { indexCalls.push(a); return { indexedFiles: 2, totalChunks: 4, status: "completed" }; },
        });
        const handlers = new ToolHandlers(ctx as any, snap);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => {};

        const result = await handlers.handleIndexCodebase({ path: codebase, embeddingModel: M06 });
        assert.equal(result.isError, undefined);
        await (handlers as any).indexingTasks.get(codebase)?.promise;

        assert.equal(indexCalls.length, 1);
        const args = indexCalls[0];
        assert.equal(args[3], false, "forceReindex must be false");
        assert.equal(args[args.length - 1], M06, "last argument scopes the run to the model");
        const priorLedgers = args[4] as Map<string, unknown>;
        assert.deepEqual([...priorLedgers.keys()], [M06], "only the scoped model's ledger is passed");
        assert.equal(cleared, 0);
        assert.equal(snap.getCodebaseStatus(codebase), "indexed");
    });
});
