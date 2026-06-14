import { OpenAIEmbedding, VoyageAIEmbedding, GeminiEmbedding, OllamaEmbedding, RabbitMQEmbedding } from "@zilliz/claude-context-core";
import type { RabbitMQEmbeddingConfig } from "@zilliz/claude-context-core";
import { getModelSpec, isCanonicalModelId } from "@zilliz/claude-context-core";
import { ContextMcpConfig } from "./config.js";

// Helper function to create embedding instance based on provider
export function createEmbeddingInstance(config: ContextMcpConfig): OpenAIEmbedding | VoyageAIEmbedding | GeminiEmbedding | OllamaEmbedding | RabbitMQEmbedding {
    console.log(`[EMBEDDING] Creating ${config.embeddingProvider} embedding instance...`);

    switch (config.embeddingProvider) {
        case 'OpenAI':
            if (!config.openaiApiKey) {
                console.error(`[EMBEDDING] ❌ OpenAI API key is required but not provided`);
                throw new Error('OPENAI_API_KEY is required for OpenAI embedding provider');
            }
            console.log(`[EMBEDDING] 🔧 Configuring OpenAI with model: ${config.embeddingModel}`);
            const openaiEmbedding = new OpenAIEmbedding({
                apiKey: config.openaiApiKey,
                model: config.embeddingModel,
                ...(config.openaiBaseUrl && { baseURL: config.openaiBaseUrl })
            });
            console.log(`[EMBEDDING] ✅ OpenAI embedding instance created successfully`);
            return openaiEmbedding;

        case 'VoyageAI':
            if (!config.voyageaiApiKey) {
                console.error(`[EMBEDDING] ❌ VoyageAI API key is required but not provided`);
                throw new Error('VOYAGEAI_API_KEY is required for VoyageAI embedding provider');
            }
            console.log(`[EMBEDDING] 🔧 Configuring VoyageAI with model: ${config.embeddingModel}`);
            const voyageEmbedding = new VoyageAIEmbedding({
                apiKey: config.voyageaiApiKey,
                model: config.embeddingModel
            });
            console.log(`[EMBEDDING] ✅ VoyageAI embedding instance created successfully`);
            return voyageEmbedding;

        case 'Gemini':
            if (!config.geminiApiKey) {
                console.error(`[EMBEDDING] ❌ Gemini API key is required but not provided`);
                throw new Error('GEMINI_API_KEY is required for Gemini embedding provider');
            }
            console.log(`[EMBEDDING] 🔧 Configuring Gemini with model: ${config.embeddingModel}`);
            const geminiEmbedding = new GeminiEmbedding({
                apiKey: config.geminiApiKey,
                model: config.embeddingModel,
                ...(config.geminiBaseUrl && { baseURL: config.geminiBaseUrl })
            });
            console.log(`[EMBEDDING] ✅ Gemini embedding instance created successfully`);
            return geminiEmbedding;

        case 'OpenRouter':
            if (!config.openrouterApiKey) {
                console.error(`[EMBEDDING] ❌ OpenRouter API key is required but not provided`);
                throw new Error('OPENROUTER_API_KEY is required for OpenRouter embedding provider');
            }
            console.log(`[EMBEDDING] 🔧 Configuring OpenRouter with model: ${config.embeddingModel}`);
            // Reuse OpenAIEmbedding with OpenRouter's OpenAI-compatible endpoint
            const openrouterEmbedding = new OpenAIEmbedding({
                apiKey: config.openrouterApiKey,
                model: config.embeddingModel,
                baseURL: 'https://openrouter.ai/api/v1',
            });
            console.log(`[EMBEDDING] ✅ OpenRouter embedding instance created successfully`);
            return openrouterEmbedding;

        case 'Ollama':
            const ollamaHost = config.ollamaHost || 'http://127.0.0.1:11434';
            console.log(`[EMBEDDING] 🔧 Configuring Ollama with model: ${config.embeddingModel}, host: ${ollamaHost}${config.ollamaDimension ? `, dimension: ${config.ollamaDimension}` : ''}`);
            const ollamaEmbedding = new OllamaEmbedding({
                model: config.embeddingModel,
                host: ollamaHost,
                ...(config.ollamaDimension && { dimension: config.ollamaDimension })
            });
            console.log(`[EMBEDDING] ✅ Ollama embedding instance created successfully`);
            return ollamaEmbedding;

        case 'RabbitMQ':
            if (!config.rabbitmqUrl) {
                console.error(`[EMBEDDING] ❌ RABBITMQ_INFERENCE_URL is required but not provided`);
                throw new Error('RABBITMQ_INFERENCE_URL is required for RabbitMQ embedding provider');
            }
            const rabbitmqQueue = config.rabbitmqQueue || 'embedding.qwen3-8b';
            const rabbitmqDimension = config.rabbitmqDimension ?? 4096;
            console.log(`[EMBEDDING] 🔧 Configuring RabbitMQ with queue: ${rabbitmqQueue}, model: ${config.embeddingModel}, dim: ${rabbitmqDimension}`);
            const rabbitmqEmbedding = new RabbitMQEmbedding({
                url: config.rabbitmqUrl,
                queue: rabbitmqQueue,
                modelName: config.embeddingModel,
                dimension: rabbitmqDimension,
                timeoutMs: config.rabbitmqTimeoutMs,
                maxRetries: config.rabbitmqMaxRetries,
                priority: config.rabbitmqPriority,
                concurrency: config.rabbitmqConcurrency,
                source: config.rabbitmqSource || 'claude-context',
            });
            console.log(`[EMBEDDING] ✅ RabbitMQ embedding instance created successfully`);
            return rabbitmqEmbedding;

        default:
            console.error(`[EMBEDDING] ❌ Unsupported embedding provider: ${config.embeddingProvider}`);
            throw new Error(`Unsupported embedding provider: ${config.embeddingProvider}`);
    }
}

export function logEmbeddingProviderInfo(config: ContextMcpConfig, embedding: OpenAIEmbedding | VoyageAIEmbedding | GeminiEmbedding | OllamaEmbedding | RabbitMQEmbedding): void {
    console.log(`[EMBEDDING] ✅ Successfully initialized ${config.embeddingProvider} embedding provider`);
    console.log(`[EMBEDDING] Provider details - Model: ${config.embeddingModel}, Dimension: ${embedding.getDimension()}`);

    // Log provider-specific configuration details
    switch (config.embeddingProvider) {
        case 'OpenAI':
            console.log(`[EMBEDDING] OpenAI configuration - API Key: ${config.openaiApiKey ? '✅ Provided' : '❌ Missing'}, Base URL: ${config.openaiBaseUrl || 'Default'}`);
            break;
        case 'VoyageAI':
            console.log(`[EMBEDDING] VoyageAI configuration - API Key: ${config.voyageaiApiKey ? '✅ Provided' : '❌ Missing'}`);
            break;
        case 'Gemini':
            console.log(`[EMBEDDING] Gemini configuration - API Key: ${config.geminiApiKey ? '✅ Provided' : '❌ Missing'}, Base URL: ${config.geminiBaseUrl || 'Default'}`);
            break;
        case 'OpenRouter':
            console.log(`[EMBEDDING] OpenRouter configuration - API Key: ${config.openrouterApiKey ? '✅ Provided' : '❌ Missing'}`);
            break;
        case 'Ollama':
            console.log(`[EMBEDDING] Ollama configuration - Host: ${config.ollamaHost || 'http://127.0.0.1:11434'}, Model: ${config.embeddingModel}${config.ollamaDimension ? `, Dimension: ${config.ollamaDimension}` : ''}`);
            break;
        case 'RabbitMQ':
            console.log(`[EMBEDDING] RabbitMQ configuration - Queue: ${config.rabbitmqQueue || 'embedding.qwen3-8b'}, URL: ${config.rabbitmqUrl ? '✅ Provided' : '❌ Missing'}`);
            break;
    }
}

/**
 * Construct the secondary (0.6B) RabbitMQEmbedding instance ONLY when the config
 * activates it (milvusCollectionPrivate0p6b is truthy). Returns undefined otherwise.
 *
 * The activation signal is the PRESENCE of MILVUS_COLLECTION_PRIVATE_0P6B — this ensures
 * that adding only a queue override does nothing, and the user must explicitly name the
 * collection they want to write into.
 *
 * Per LD-2: secondary uses a SEPARATE RabbitMQEmbedding instance from the primary because
 * the per-instance dimension guard in rabbitmq-embedding.ts forbids reusing one instance
 * across dimensions (dim guard rejects wrong-dim replies at the protocol level).
 *
 * All diagnostic output goes to stderr — never stdout (JSON-RPC sanctity).
 */
export function createSecondaryEmbeddingInstance(
    config: ContextMcpConfig,
): RabbitMQEmbedding | undefined {
    // Activation check: MILVUS_COLLECTION_PRIVATE_0P6B must be set.
    if (!config.milvusCollectionPrivate0p6b) {
        console.error('[EMBEDDING] Secondary embedding: MILVUS_COLLECTION_PRIVATE_0P6B not set → secondary OFF (single-model mode)');
        return undefined;
    }

    // Only RabbitMQ supports secondary instances in this fork (the other providers
    // do not have the per-instance dimension guard needed for Option B).
    if (config.embeddingProvider !== 'RabbitMQ') {
        console.error(
            `[EMBEDDING] Secondary embedding: provider=${config.embeddingProvider} does not support dual-model — secondary disabled. ` +
            `Set EMBEDDING_PROVIDER=RabbitMQ to enable.`
        );
        return undefined;
    }

    if (!config.rabbitmqUrl) {
        console.error('[EMBEDDING] Secondary embedding: RABBITMQ_INFERENCE_URL not set — secondary disabled');
        return undefined;
    }

    // Resolve secondary spec from registry; allow env overrides for non-standard deployments.
    const secondaryModelId = config.rabbitmqSecondaryModel ?? 'qwen3-embedding-0.6b';
    if (!isCanonicalModelId(secondaryModelId)) {
        console.error(
            `[EMBEDDING] Secondary embedding: RABBITMQ_SECONDARY_MODEL='${secondaryModelId}' is not a canonical model id. ` +
            `Secondary disabled.`
        );
        return undefined;
    }
    const spec = getModelSpec(secondaryModelId);

    const secondaryQueue = config.rabbitmqSecondaryQueue ?? spec.queue;
    const secondaryDimension = config.rabbitmqSecondaryDimension ?? spec.dimension;

    const rmqCfg: RabbitMQEmbeddingConfig = {
        url: config.rabbitmqUrl,
        queue: secondaryQueue,
        modelName: secondaryModelId,
        dimension: secondaryDimension,
        // Inherit timeout/retries from primary config — secondary runs at background priority,
        // so being patient is correct. maxRetries stays the same (WAIT-tolerance).
        timeoutMs: config.rabbitmqTimeoutMs,
        maxRetries: config.rabbitmqMaxRetries,
        // Secondary uses registry priorityDefault (=1) unless caller overrides at embed time.
        // Do NOT inherit rabbitmqPriority from primary (that is the interactive 8B priority=10).
        priority: spec.priorityDefault,
        concurrency: config.rabbitmqConcurrency,
        source: config.rabbitmqSource ?? 'claude-context',
    };

    const secondary = new RabbitMQEmbedding(rmqCfg);

    // Startup stderr log — provider/queue/dim triplet for observability (never stdout).
    console.error(
        `[EMBEDDING] Secondary instance ACTIVE — provider=RabbitMQ queue=${secondaryQueue} dim=${secondaryDimension} model=${secondaryModelId} collection=${config.milvusCollectionPrivate0p6b}`
    );

    return secondary;
}

/**
 * Log the active model configuration to stderr at MCP startup.
 * Called AFTER both instances are constructed so the log is a complete picture.
 * NEVER writes to stdout.
 */
export function logActiveModels(
    primaryQueue: string,
    primaryDim: number,
    secondaryQueue: string | undefined,
    secondaryDim: number | undefined,
    searchDefault: string,
): void {
    console.error(`[EMBEDDING] Active models:`);
    console.error(`[EMBEDDING]   primary:   queue=${primaryQueue} dim=${primaryDim}`);
    if (secondaryQueue !== undefined) {
        console.error(`[EMBEDDING]   secondary: queue=${secondaryQueue} dim=${secondaryDim}`);
    } else {
        console.error(`[EMBEDDING]   secondary: OFF`);
    }
    console.error(`[EMBEDDING]   searchDefault: ${searchDefault}`);
}
