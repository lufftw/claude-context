import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpConfig } from "./config.js";

// The query lane, the indexing priority and the indexing depth gate are configurable from the
// environment. Unset keys stay undefined, so the client's own defaults apply.

const KEYS = [
    "RABBITMQ_EMBEDDING_INDEX_PRIORITY",
    "RABBITMQ_EMBEDDING_QUERY_TIMEOUT_MS",
    "RABBITMQ_EMBEDDING_INDEX_DEPTH_LIMIT",
] as const;

function withEnv(vars: Partial<Record<(typeof KEYS)[number], string>>, run: () => void): void {
    const saved = new Map<string, string | undefined>(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) {
        const v = vars[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        run();
    } finally {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test("reads the indexing priority, the query timeout and the depth limit", () => {
    withEnv({
        RABBITMQ_EMBEDDING_INDEX_PRIORITY: "3",
        RABBITMQ_EMBEDDING_QUERY_TIMEOUT_MS: "20000",
        RABBITMQ_EMBEDDING_INDEX_DEPTH_LIMIT: "500",
    }, () => {
        const config = createMcpConfig();
        assert.equal(config.rabbitmqIndexPriority, 3);
        assert.equal(config.rabbitmqQueryTimeoutMs, 20000);
        assert.equal(config.rabbitmqIndexDepthLimit, 500);
    });
});

test("keeps a depth limit of 0, which turns the gate off", () => {
    withEnv({ RABBITMQ_EMBEDDING_INDEX_DEPTH_LIMIT: "0" }, () => {
        assert.equal(createMcpConfig().rabbitmqIndexDepthLimit, 0);
    });
});

test("leaves the three undefined when unset, so the client's defaults apply", () => {
    withEnv({}, () => {
        const config = createMcpConfig();
        assert.equal(config.rabbitmqIndexPriority, undefined);
        assert.equal(config.rabbitmqQueryTimeoutMs, undefined);
        assert.equal(config.rabbitmqIndexDepthLimit, undefined);
    });
});
