// The snapshot under CLAUDE_CONTEXT_HOME is shared by every project's MCP process. A process can only recognise
// its OWN custom collection (MILVUS_COLLECTION_PRIVATE), so another project's custom-named collection looks like a
// "non-code collection" to it. Cloud sync used to remove every local codebase it could not find, which wiped other
// projects' entries, their per-model ledgers and their merkle snapshots on every search/status call. Default now:
// never prune; the upstream behaviour is opt-in with CLAUDE_CONTEXT_SYNC_PRUNE=true.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";

async function withTempHome(run: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-context-mcp-sync-"));
    const home = path.join(root, "home");
    await mkdir(home, { recursive: true });
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PRUNE: process.env.CLAUDE_CONTEXT_SYNC_PRUNE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
        await run(root);
    } finally {
        for (const [k, v] of [["HOME", saved.HOME], ["USERPROFILE", saved.USERPROFILE], ["CLAUDE_CONTEXT_SYNC_PRUNE", saved.PRUNE]] as const) {
            if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v;
        }
        await rm(root, { recursive: true, force: true });
    }
}

/** This process owns `own_collection` (holding codebase A). Codebase B lives in another project's custom collection. */
function contextStub(ownPath: string) {
    return {
        getVectorDatabase: () => ({
            listCollections: async () => ["own_collection", "other_project_own"],
            getCollectionDescription: async (c: string) => (c === "own_collection" ? `codebasePath:${ownPath}` : ""),
            query: async () => [],
        }),
        getCollectionName: () => "own_collection",
        getWritableSharedCollectionName: () => undefined,
        getSharedCollectionName: () => undefined,
    };
}

async function setup(root: string) {
    const a = path.join(root, "A"), b = path.join(root, "B");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    const snap = new SnapshotManager();
    snap.setCodebaseIndexed(a, { indexedFiles: 1, totalChunks: 1, status: "completed" });
    snap.setCodebaseIndexed(b, { indexedFiles: 2, totalChunks: 2, status: "completed" });
    snap.setFileCompleteForModel(b, "qwen3-embedding-8b", "x.ts", { complete: true, fileHash: "h", chunkCount: 2 });
    snap.saveCodebaseSnapshot();
    return { a, b, snap };
}

test("cloud sync keeps another project's entry and ledger by default", async () => {
    await withTempHome(async (root) => {
        delete process.env.CLAUDE_CONTEXT_SYNC_PRUNE;
        const { a, b, snap } = await setup(root);
        const handlers = new ToolHandlers(contextStub(a) as any, snap);
        await (handlers as any).syncIndexedCodebasesFromCloud();
        const fresh = new SnapshotManager();
        fresh.loadCodebaseSnapshot();
        assert.equal(fresh.getCodebaseStatus(b), "indexed");
        assert.equal(fresh.getFileLedgerForModel(b, "qwen3-embedding-8b").size, 1);
        assert.equal(fresh.getCodebaseStatus(a), "indexed");
    });
});

test("cloud sync prunes unseen codebases only when CLAUDE_CONTEXT_SYNC_PRUNE=true", async () => {
    await withTempHome(async (root) => {
        process.env.CLAUDE_CONTEXT_SYNC_PRUNE = "true";
        const { a, b, snap } = await setup(root);
        const handlers = new ToolHandlers(contextStub(a) as any, snap);
        await (handlers as any).syncIndexedCodebasesFromCloud();
        assert.equal(snap.getCodebaseStatus(b), "not_found");
        assert.equal(snap.getCodebaseStatus(a), "indexed");
    });
});
