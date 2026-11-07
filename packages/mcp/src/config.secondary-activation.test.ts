// The 0.6B model is switched by EMBEDDING_SECONDARY, not by a collection name in the env block. Each repository's own .env
// already names its 0.6B collection; requiring a name in the server's env block left 0.6B off in every session whose block
// did not carry one, so the embeddingModel override always answered "secondary-not-configured" there.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMcpConfig } from "./config.js";
import { createSecondaryEmbeddingInstance } from "./embedding.js";

const KEYS = ["EMBEDDING_PROVIDER", "EMBEDDING_SECONDARY", "MILVUS_COLLECTION_PRIVATE_0P6B", "RABBITMQ_INFERENCE_URL"];
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
const withEnv = (env: Record<string, string>) => {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
    return createMcpConfig();
};
const RMQ = { EMBEDDING_PROVIDER: "RabbitMQ", RABBITMQ_INFERENCE_URL: "amqp://u:p@127.0.0.1:1/inference" };

describe("secondary (0.6B) activation", () => {
    afterEach(() => {
        for (const k of KEYS) {
            if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
        }
    });

    it("is on for RabbitMQ without any collection name in the env block", () => {
        const cfg = withEnv(RMQ);
        assert.equal(cfg.secondaryEnabled, true);
        assert.ok(createSecondaryEmbeddingInstance(cfg), "the 0.6B embedder is constructed");
    });

    it("stays on when an older env block names the 0.6B collection", () => {
        assert.equal(withEnv({ ...RMQ, MILVUS_COLLECTION_PRIVATE_0P6B: "x_own_0p6b" }).secondaryEnabled, true);
    });

    it("is turned off by EMBEDDING_SECONDARY=off, even with a collection name", () => {
        const cfg = withEnv({ ...RMQ, EMBEDDING_SECONDARY: "off", MILVUS_COLLECTION_PRIVATE_0P6B: "x_own_0p6b" });
        assert.equal(cfg.secondaryEnabled, false);
        assert.equal(createSecondaryEmbeddingInstance(cfg), undefined);
    });

    it("is off for providers that cannot run two models", () => {
        assert.equal(withEnv({ EMBEDDING_PROVIDER: "OpenAI" }).secondaryEnabled, false);
    });

    it("ignores an unrecognised value and keeps the provider default", () => {
        assert.equal(withEnv({ ...RMQ, EMBEDDING_SECONDARY: "maybe" }).secondaryEnabled, true);
    });
});
