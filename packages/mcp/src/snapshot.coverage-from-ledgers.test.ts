import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";

const M8 = "qwen3-embedding-8b";
const M06 = "qwen3-embedding-0.6b";
const CODEBASE = "/repo";

async function withTempHome(run: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-context-mcp-coverage-"));
    const homeDir = path.join(root, "home");
    await mkdir(homeDir, { recursive: true });
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    try {
        await run(root);
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v;
        }
        await rm(root, { recursive: true, force: true });
    }
}

function file(fileHash: string, chunkCount: number, complete = true) {
    return { complete, fileHash, chunkCount };
}

test("coverage: identical ledgers give 1", async () => {
    await withTempHome(async () => {
        const snap = new SnapshotManager();
        snap.setFileCompleteForModel(CODEBASE, M8, "a.ts", file("ha", 3));
        snap.setFileCompleteForModel(CODEBASE, M06, "a.ts", file("ha", 3));

        snap.refreshCoverageFromLedgers(CODEBASE, [M06]);

        assert.equal(snap.getCoverageRatioForModel(CODEBASE, M06), 1);
    });
});

test("coverage: weighted by chunks, so one missing large file counts for its size", async () => {
    await withTempHome(async () => {
        const snap = new SnapshotManager();
        snap.setFileCompleteForModel(CODEBASE, M8, "big.ts", file("hb", 9));
        snap.setFileCompleteForModel(CODEBASE, M8, "small.ts", file("hs", 1));
        snap.setFileCompleteForModel(CODEBASE, M06, "small.ts", file("hs", 1));

        snap.refreshCoverageFromLedgers(CODEBASE, [M06]);

        assert.equal(snap.getCoverageRatioForModel(CODEBASE, M06), 0.1);
    });
});

test("coverage: an incomplete file and a stale hash do not count", async () => {
    await withTempHome(async () => {
        const snap = new SnapshotManager();
        snap.setFileCompleteForModel(CODEBASE, M8, "partial.ts", file("hp", 2));
        snap.setFileCompleteForModel(CODEBASE, M8, "changed.ts", file("new", 2));
        snap.setFileCompleteForModel(CODEBASE, M06, "partial.ts", file("hp", 1, false));
        snap.setFileCompleteForModel(CODEBASE, M06, "changed.ts", file("old", 2));

        snap.refreshCoverageFromLedgers(CODEBASE, [M06]);

        assert.equal(snap.getCoverageRatioForModel(CODEBASE, M06), 0);
    });
});

test("coverage: a secondary holding fewer chunks of a file is not credited with the primary's count", async () => {
    await withTempHome(async () => {
        const snap = new SnapshotManager();
        snap.setFileCompleteForModel(CODEBASE, M8, "a.ts", file("ha", 4));
        snap.setFileCompleteForModel(CODEBASE, M06, "a.ts", file("ha", 3));

        snap.refreshCoverageFromLedgers(CODEBASE, [M06]);

        assert.equal(snap.getCoverageRatioForModel(CODEBASE, M06), 0.75);
    });
});

test("coverage: an empty primary ledger cannot be measured, so nothing is written", async () => {
    await withTempHome(async () => {
        const snap = new SnapshotManager();
        snap.setCodebaseIndexed(CODEBASE, { indexedFiles: 1, totalChunks: 1, status: "completed" });
        snap.setCoverageRatioForModel(CODEBASE, M06, 0.9);
        snap.setFileCompleteForModel(CODEBASE, M06, "a.ts", file("ha", 3));

        snap.refreshCoverageFromLedgers(CODEBASE, [M06]);

        assert.equal(snap.getCoverageRatioForModel(CODEBASE, M06), 0.9);
    });
});

test("coverage: the primary model is never given a ratio", async () => {
    await withTempHome(async () => {
        const snap = new SnapshotManager();
        snap.setFileCompleteForModel(CODEBASE, M8, "a.ts", file("ha", 3));

        snap.refreshCoverageFromLedgers(CODEBASE, [M8, M06]);

        assert.equal(snap.getCoverageRatioForModel(CODEBASE, M8), undefined);
        assert.equal(snap.getCoverageRatioForModel(CODEBASE, M06), 0);
    });
});

function indexingContext(fileHash: string) {
    return {
        getActiveModelIds: () => [M8, M06],
        resolveScopedModelIds: (id?: string) => (id ? [id] : [M8, M06]),
        getEmbedding: () => ({ getProvider: () => "RabbitMQ", getDimension: () => 4096 }),
        getLoadedIgnorePatterns: () => [],
        getCustomIgnorePatterns: () => [],
        addCustomExtensions: () => {},
        addCustomIgnorePatterns: () => {},
        clearCustomIgnorePatterns: () => {},
        clearCustomExtensions: () => {},
        indexCodebase: async (...args: any[]) => {
            const onFile = args[2];
            onFile(M8, "a.ts", file(fileHash, 2));
            onFile(M06, "a.ts", file(fileHash, 2));
            return { indexedFiles: 1, totalChunks: 2, status: "completed" };
        },
    };
}

test("scoped index run persists coverage, which makes the secondary readable without a manual step", async () => {
    await withTempHome(async () => {
        const snap = new SnapshotManager();
        const handlers = new ToolHandlers(indexingContext("ha") as any, snap);

        await (handlers as any).startBackgroundModelIndexing(CODEBASE, M06, "ast", [], [], new AbortController().signal);

        assert.equal(snap.getCoverageRatioForModel(CODEBASE, M06), 1);
    });
});

test("full index run persists coverage as well", async () => {
    await withTempHome(async (root) => {
        const codebase = path.join(root, "repo");
        await mkdir(codebase, { recursive: true });
        const snap = new SnapshotManager();
        const context = {
            ...indexingContext("ha"),
            getPreparedCollection: async () => {},
            getCollectionName: () => "c",
            setSynchronizer: () => {},
            getEffectiveIgnorePatterns: async () => [],
            getEffectiveSupportedExtensions: () => [".ts"],
            getIncludeDotDirs: () => [],
        };
        const handlers = new ToolHandlers(context as any, snap);

        await (handlers as any).startBackgroundIndexing(codebase, false, "ast");

        assert.equal(snap.getCodebaseStatus(codebase), "indexed");
        assert.equal(snap.getCoverageRatioForModel(codebase, M06), 1);
    });
});
