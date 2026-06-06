// Edit H — RABBITMQ_EMBEDDING_MAX_RETRIES parsing contract.
//
// The mcp package has no jest harness (ESM, no jest config), and the Commit-1
// add-set scopes tests to packages/core/src/embedding/__tests__. The actual
// field plumbing (config.ts -> ContextMcpConfig.rabbitmqMaxRetries ->
// RabbitMQEmbedding constructor) is enforced by `pnpm typecheck`/`pnpm build`.
//
// What is NOT covered by the type system is the runtime parse semantics, which
// mirror the existing pattern in config.ts exactly:
//     const raw = envManager.get('RABBITMQ_EMBEDDING_MAX_RETRIES');
//     rabbitmqMaxRetries: raw ? parseInt(raw, 10) : undefined
// This test pins that contract: a numeric env string parses to the int; an
// absent value yields undefined.

// Pure replica of the production parse expression (string-in -> number|undefined).
function parseMaxRetries(raw: string | undefined): number | undefined {
    return raw ? parseInt(raw, 10) : undefined;
}

describe('Edit H — RABBITMQ_EMBEDDING_MAX_RETRIES parse contract', () => {
    it('parses "2" to the integer 2', () => {
        expect(parseMaxRetries('2')).toBe(2);
    });

    it('parses "0" — but note the truthiness guard treats empty as absent, not 0', () => {
        // '0' is a non-empty string -> parsed to numeric 0.
        expect(parseMaxRetries('0')).toBe(0);
    });

    it('returns undefined when the env var is absent', () => {
        expect(parseMaxRetries(undefined)).toBeUndefined();
    });

    it('returns undefined for an empty string (matches existing config pattern)', () => {
        expect(parseMaxRetries('')).toBeUndefined();
    });
});
