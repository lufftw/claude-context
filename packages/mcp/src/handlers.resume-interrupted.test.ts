import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";

const M8 = "qwen3-embedding-8b";

async function withTempHome(run: (root: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-context-mcp-resume-"));
    const homeDir = path.join(tempRoot, "home");
    const codebase = path.join(tempRoot, "repo");
    await mkdir(homeDir, { recursive: true });
    await mkdir(codebase, { recursive: true });
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONTEXT_HOME: process.env.CLAUDE_CONTEXT_HOME };
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.CLAUDE_CONTEXT_HOME;
    try {
        await run(codebase);
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v;
        }
        await rm(tempRoot, { recursive: true, force: true });
    }
}

/** A context stub whose vector database already holds rows for the codebase. */
function contextStub() {
    return {
        getActiveModelIds: () => [M8],
        resolveScopedModelIds: () => [M8],
        hasIndex: async () => true,
        getVectorDatabase: () => ({ checkCollectionLimit: async () => true }),
    };
}

function handlersFor(snap: SnapshotManager) {
    const handlers = new ToolHandlers(contextStub() as any, snap);
    let started = 0;
    (handlers as any).syncIndexedCodebasesFromCloud = async () => {};
    (handlers as any).queryCollectionStats = async () => ({ indexedFiles: 1, totalChunks: 10 });
    (handlers as any).startBackgroundIndexing = async () => { started += 1; };
    return { handlers, started: () => started };
}

test("index_codebase resumes an interrupted run that still has rows and a per-file ledger", async () => {
    await withTempHome(async (codebase) => {
        const snap = new SnapshotManager();
        snap.setCodebaseIndexing(codebase, 73);
        snap.setFileCompleteForModel(codebase, M8, "a.ts", { complete: true, fileHash: "h", chunkCount: 3 });
        snap.saveCodebaseSnapshot();
        // What the failed run leaves on disk: status indexfailed, the per-file ledger kept beside it.
        const file = (snap as any).snapshotFilePath as string;
        const doc = JSON.parse(readFileSync(file, "utf8"));
        const entry = doc.codebases[codebase];
        entry.status = "indexfailed";
        entry.errorMessage = "Aborting indexing: 3 consecutive REAL-class chunk-batch failures.";
        delete entry.indexingPercentage;
        writeFileSync(file, JSON.stringify(doc));
        const fresh = new SnapshotManager();
        fresh.loadCodebaseSnapshot();
        const { handlers, started } = handlersFor(fresh);
        const result = await handlers.handleIndexCodebase({ path: codebase });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        assert.equal(started(), 1, "the background run must start");
        assert.equal(fresh.getFileLedgerForModel(codebase, M8).size, 1, "the ledger must survive");
    });
});

test("index_codebase still refuses a codebase that is indexed", async () => {
    await withTempHome(async (codebase) => {
        const snap = new SnapshotManager();
        snap.setCodebaseIndexed(codebase, { indexedFiles: 1, totalChunks: 10, status: "completed" });
        snap.saveCodebaseSnapshot();
        const { handlers, started } = handlersFor(snap);
        const result = await handlers.handleIndexCodebase({ path: codebase });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /already indexed/);
        assert.equal(started(), 0);
    });
});

test("index_codebase still recovers a missing snapshot when rows exist and no ledger does", async () => {
    await withTempHome(async (codebase) => {
        const snap = new SnapshotManager();
        const { handlers, started } = handlersFor(snap);
        const result = await handlers.handleIndexCodebase({ path: codebase });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /already indexed/);
        assert.equal(started(), 0);
    });
});
