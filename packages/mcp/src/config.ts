import { envManager } from "@zilliz/claude-context-core";

export interface ContextMcpConfig {
    name: string;
    version: string;
    // Embedding provider configuration
    embeddingProvider: 'OpenAI' | 'VoyageAI' | 'Gemini' | 'Ollama' | 'OpenRouter' | 'RabbitMQ';
    embeddingModel: string;
    // Provider-specific API keys
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    voyageaiApiKey?: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    // OpenRouter configuration
    openrouterApiKey?: string;
    // Ollama configuration
    ollamaModel?: string;
    ollamaHost?: string;
    ollamaDimension?: number;
    // RabbitMQ primary inference-queue configuration
    rabbitmqUrl?: string;
    rabbitmqQueue?: string;
    rabbitmqDimension?: number;
    rabbitmqTimeoutMs?: number;
    rabbitmqMaxRetries?: number;
    rabbitmqPriority?: number;
    rabbitmqConcurrency?: number;
    rabbitmqSource?: string;
    // RabbitMQ secondary (0.6B) configuration — all undefined = secondary disabled.
    // Activation signal: milvusCollectionPrivate0p6b must be truthy to enable secondary.
    rabbitmqSecondaryQueue?: string;       // RABBITMQ_SECONDARY_QUEUE; default from registry if activated
    rabbitmqSecondaryDimension?: number;   // RABBITMQ_SECONDARY_DIMENSION; default 1024 if activated
    rabbitmqSecondaryModel?: string;       // RABBITMQ_SECONDARY_MODEL; default 'qwen3-embedding-0.6b' if activated
    // Dual-embedding Milvus configuration
    milvusCollectionPrivate0p6b?: string; // MILVUS_COLLECTION_PRIVATE_0P6B — ACTIVATION SIGNAL; absent = secondary OFF
    // Search configuration
    searchEmbeddingModel: string;          // SEARCH_EMBEDDING_MODEL; default 'qwen3-embedding-8b'
    // Vector database configuration
    milvusAddress?: string; // Optional, can be auto-resolved from token
    milvusToken?: string;
}

// Legacy format (v1) - for backward compatibility
export interface CodebaseSnapshotV1 {
    indexedCodebases: string[];
    indexingCodebases: string[] | Record<string, number>;  // Array (legacy) or Map of codebase path to progress percentage
    lastUpdated: string;
}

// New format (v2) - structured with codebase information

// Per-file completeness ledger entry (Commit 3/4).
// Written durably by the snapshot manager from core's onFileComplete callback.
// `complete` is the gate a resume reads (Commit 4): only complete:true files
// may be skipped; a partial/orphaned file (complete:false) must be re-indexed.
export interface FileCompleteness {
    fileHash: string;    // SHA-256 of the file content embedded into its chunks
    chunkCount: number;  // chunks confirmed inserted for this file
    complete: boolean;   // true ⇔ every produced chunk for the file was inserted
}

// Base interface for common fields
interface CodebaseInfoBase {
    lastUpdated: string;
}

// Indexing state - when indexing is in progress
export interface CodebaseInfoIndexing extends CodebaseInfoBase {
    status: 'indexing';
    indexingPercentage: number;  // Current progress percentage
    files?: Record<string, FileCompleteness>;  // Per-file completeness ledger (Commit 3/4)
}

// Indexed state - when indexing completed successfully
export interface CodebaseInfoIndexed extends CodebaseInfoBase {
    status: 'indexed';
    indexedFiles: number;        // Number of files indexed
    totalChunks: number;         // Total number of chunks generated
    indexStatus: 'completed' | 'limit_reached';  // Status from indexing result
    files?: Record<string, FileCompleteness>;  // Per-file completeness ledger (Commit 3/4)
}

// Index failed state - when indexing failed
export interface CodebaseInfoIndexFailed extends CodebaseInfoBase {
    status: 'indexfailed';
    errorMessage: string;        // Error message from the failure
    lastAttemptedPercentage?: number;  // Progress when failure occurred
}

// Union type for all codebase information states
export type CodebaseInfo = CodebaseInfoIndexing | CodebaseInfoIndexed | CodebaseInfoIndexFailed;

export interface CodebaseSnapshotV2 {
    formatVersion: 'v2';
    codebases: Record<string, CodebaseInfo>;  // codebasePath -> CodebaseInfo
    lastUpdated: string;
}

// Union type for all supported formats
export type CodebaseSnapshot = CodebaseSnapshotV1 | CodebaseSnapshotV2;

// Helper function to get default model for each provider
export function getDefaultModelForProvider(provider: string): string {
    switch (provider) {
        case 'OpenAI':
            return 'text-embedding-3-small';
        case 'VoyageAI':
            return 'voyage-code-3';
        case 'Gemini':
            return 'gemini-embedding-001';
        case 'OpenRouter':
            return 'openai/text-embedding-3-small';
        case 'Ollama':
            return 'nomic-embed-text';
        case 'RabbitMQ':
            return 'qwen3-embedding-8b';
        default:
            return 'text-embedding-3-small';
    }
}

// Helper function to get embedding model with provider-specific environment variable priority
export function getEmbeddingModelForProvider(provider: string): string {
    switch (provider) {
        case 'Ollama':
            // For Ollama, prioritize OLLAMA_MODEL over EMBEDDING_MODEL for backward compatibility
            const ollamaModel = envManager.get('OLLAMA_MODEL') || envManager.get('EMBEDDING_MODEL') || getDefaultModelForProvider(provider);
            console.log(`[DEBUG] 🎯 Ollama model selection: OLLAMA_MODEL=${envManager.get('OLLAMA_MODEL') || 'NOT SET'}, EMBEDDING_MODEL=${envManager.get('EMBEDDING_MODEL') || 'NOT SET'}, selected=${ollamaModel}`);
            return ollamaModel;
        case 'RabbitMQ':
            // RabbitMQ passes the logical model name in the task body. The worker on the
            // other side ignores this field for routing (routing is by queue name) but we
            // still include it so worker-side observability / metrics stay meaningful.
            const rmqModel = envManager.get('EMBEDDING_MODEL') || getDefaultModelForProvider(provider);
            console.log(`[DEBUG] 🎯 RabbitMQ model selection: EMBEDDING_MODEL=${envManager.get('EMBEDDING_MODEL') || 'NOT SET'}, selected=${rmqModel}`);
            return rmqModel;
        case 'OpenAI':
        case 'VoyageAI':
        case 'Gemini':
        case 'OpenRouter':
        default:
            // For all other providers, use EMBEDDING_MODEL or default
            const selectedModel = envManager.get('EMBEDDING_MODEL') || getDefaultModelForProvider(provider);
            console.log(`[DEBUG] 🎯 ${provider} model selection: EMBEDDING_MODEL=${envManager.get('EMBEDDING_MODEL') || 'NOT SET'}, selected=${selectedModel}`);
            return selectedModel;
    }
}

function getPositiveIntegerFromEnv(name: string): number | undefined {
    const rawValue = envManager.get(name);
    if (!rawValue) {
        return undefined;
    }

    const parsedValue = Number(rawValue);
    if (Number.isInteger(parsedValue) && parsedValue > 0) {
        return parsedValue;
    }

    console.warn(`[DEBUG] ⚠️  Ignoring invalid ${name}: ${rawValue}. Expected a positive integer.`);
    return undefined;
}

export function createMcpConfig(): ContextMcpConfig {
    // Debug: Print all environment variables related to Context
    console.error(`[DEBUG] Environment Variables Debug:`);
    console.error(`[DEBUG]   EMBEDDING_PROVIDER: ${envManager.get('EMBEDDING_PROVIDER') || 'NOT SET'}`);
    console.error(`[DEBUG]   EMBEDDING_MODEL: ${envManager.get('EMBEDDING_MODEL') || 'NOT SET'}`);
    console.error(`[DEBUG]   EMBEDDING_DIMENSION: ${envManager.get('EMBEDDING_DIMENSION') || 'NOT SET'}`);
    console.error(`[DEBUG]   OLLAMA_MODEL: ${envManager.get('OLLAMA_MODEL') || 'NOT SET'}`);
    console.error(`[DEBUG]   GEMINI_API_KEY: ${envManager.get('GEMINI_API_KEY') ? 'SET (length: ' + envManager.get('GEMINI_API_KEY')!.length + ')' : 'NOT SET'}`);
    console.error(`[DEBUG]   OPENAI_API_KEY: ${envManager.get('OPENAI_API_KEY') ? 'SET (length: ' + envManager.get('OPENAI_API_KEY')!.length + ')' : 'NOT SET'}`);
    console.error(`[DEBUG]   MILVUS_ADDRESS: ${envManager.get('MILVUS_ADDRESS') || 'NOT SET'}`);
    console.error(`[DEBUG]   NODE_ENV: ${envManager.get('NODE_ENV') || 'NOT SET'}`);
    console.error(`[DEBUG]   MILVUS_COLLECTION_PRIVATE_0P6B: ${envManager.get('MILVUS_COLLECTION_PRIVATE_0P6B') || 'NOT SET (secondary OFF)'}`);
    console.error(`[DEBUG]   SEARCH_EMBEDDING_MODEL: ${envManager.get('SEARCH_EMBEDDING_MODEL') || 'NOT SET (default: qwen3-embedding-8b)'}`);

    const rabbitmqDim = envManager.get('RABBITMQ_EMBEDDING_DIMENSION');
    const rabbitmqTimeout = envManager.get('RABBITMQ_EMBEDDING_TIMEOUT_MS');
    const rabbitmqMaxRetries = envManager.get('RABBITMQ_EMBEDDING_MAX_RETRIES');
    const rabbitmqPriority = envManager.get('RABBITMQ_EMBEDDING_PRIORITY');
    const rabbitmqConcurrency = envManager.get('RABBITMQ_EMBEDDING_CONCURRENCY');

    // Secondary RabbitMQ dimension — parse only if present
    const rabbitmqSecDimRaw = envManager.get('RABBITMQ_SECONDARY_DIMENSION');
    const rabbitmqSecondaryDimension = rabbitmqSecDimRaw
        ? parseInt(rabbitmqSecDimRaw, 10)
        : undefined;

    // Validate SEARCH_EMBEDDING_MODEL against the registry if set
    const searchEmbeddingModelRaw = envManager.get('SEARCH_EMBEDDING_MODEL');
    // Import inline to avoid top-level circular risk; the registry is pure data.
    // We defer the throw to the consumer (Phase 4 factory) so startup does not crash
    // if the key is mistyped — a startup-time stderr warning is emitted instead.
    const searchEmbeddingModel = searchEmbeddingModelRaw || 'qwen3-embedding-8b';

    const config: ContextMcpConfig = {
        name: envManager.get('MCP_SERVER_NAME') || "Context MCP Server",
        version: envManager.get('MCP_SERVER_VERSION') || "1.0.0",
        // Embedding provider configuration
        embeddingProvider: (envManager.get('EMBEDDING_PROVIDER') as 'OpenAI' | 'VoyageAI' | 'Gemini' | 'Ollama' | 'OpenRouter' | 'RabbitMQ') || 'OpenAI',
        embeddingModel: getEmbeddingModelForProvider(envManager.get('EMBEDDING_PROVIDER') || 'OpenAI'),
        // Provider-specific API keys
        openaiApiKey: envManager.get('OPENAI_API_KEY'),
        openaiBaseUrl: envManager.get('OPENAI_BASE_URL'),
        voyageaiApiKey: envManager.get('VOYAGEAI_API_KEY'),
        geminiApiKey: envManager.get('GEMINI_API_KEY'),
        geminiBaseUrl: envManager.get('GEMINI_BASE_URL'),
        // OpenRouter configuration
        openrouterApiKey: envManager.get('OPENROUTER_API_KEY'),
        // Ollama configuration
        ollamaModel: envManager.get('OLLAMA_MODEL'),
        ollamaHost: envManager.get('OLLAMA_HOST'),
        ollamaDimension: getPositiveIntegerFromEnv('EMBEDDING_DIMENSION'),
        // RabbitMQ primary configuration
        rabbitmqUrl: envManager.get('RABBITMQ_INFERENCE_URL'),
        rabbitmqQueue: envManager.get('RABBITMQ_EMBEDDING_QUEUE'),
        rabbitmqDimension: rabbitmqDim ? parseInt(rabbitmqDim, 10) : undefined,
        rabbitmqTimeoutMs: rabbitmqTimeout ? parseInt(rabbitmqTimeout, 10) : undefined,
        rabbitmqMaxRetries: rabbitmqMaxRetries ? parseInt(rabbitmqMaxRetries, 10) : undefined,
        rabbitmqPriority: rabbitmqPriority ? parseInt(rabbitmqPriority, 10) : undefined,
        rabbitmqConcurrency: rabbitmqConcurrency ? parseInt(rabbitmqConcurrency, 10) : undefined,
        rabbitmqSource: envManager.get('RABBITMQ_EMBEDDING_SOURCE'),
        // RabbitMQ secondary (0.6B) configuration — undefined when not activated
        rabbitmqSecondaryQueue: envManager.get('RABBITMQ_SECONDARY_QUEUE'),
        rabbitmqSecondaryDimension,
        rabbitmqSecondaryModel: envManager.get('RABBITMQ_SECONDARY_MODEL'),
        // Dual-embedding Milvus — milvusCollectionPrivate0p6b presence = activation signal
        milvusCollectionPrivate0p6b: envManager.get('MILVUS_COLLECTION_PRIVATE_0P6B'),
        // Search configuration
        searchEmbeddingModel,
        // Vector database configuration - address can be auto-resolved from token
        milvusAddress: envManager.get('MILVUS_ADDRESS'), // Optional, can be resolved from token
        milvusToken: envManager.get('MILVUS_TOKEN')
    };

    return config;
}

export function logConfigurationSummary(config: ContextMcpConfig): void {
    // Log configuration summary before starting server
    console.log(`[MCP] 🚀 Starting Context MCP Server`);
    console.log(`[MCP] Configuration Summary:`);
    console.log(`[MCP]   Server: ${config.name} v${config.version}`);
    console.log(`[MCP]   Embedding Provider: ${config.embeddingProvider}`);
    console.log(`[MCP]   Embedding Model: ${config.embeddingModel}`);
    console.log(`[MCP]   Milvus Address: ${config.milvusAddress || (config.milvusToken ? '[Auto-resolve from token]' : '[Not configured]')}`);

    // Log provider-specific configuration without exposing sensitive data
    switch (config.embeddingProvider) {
        case 'OpenAI':
            console.log(`[MCP]   OpenAI API Key: ${config.openaiApiKey ? '✅ Configured' : '❌ Missing'}`);
            if (config.openaiBaseUrl) {
                console.log(`[MCP]   OpenAI Base URL: ${config.openaiBaseUrl}`);
            }
            break;
        case 'VoyageAI':
            console.log(`[MCP]   VoyageAI API Key: ${config.voyageaiApiKey ? '✅ Configured' : '❌ Missing'}`);
            break;
        case 'Gemini':
            console.log(`[MCP]   Gemini API Key: ${config.geminiApiKey ? '✅ Configured' : '❌ Missing'}`);
            if (config.geminiBaseUrl) {
                console.log(`[MCP]   Gemini Base URL: ${config.geminiBaseUrl}`);
            }
            break;
        case 'OpenRouter':
            console.log(`[MCP]   OpenRouter API Key: ${config.openrouterApiKey ? '✅ Configured' : '❌ Missing'}`);
            break;
        case 'Ollama':
            console.log(`[MCP]   Ollama Host: ${config.ollamaHost || 'http://127.0.0.1:11434'}`);
            console.log(`[MCP]   Ollama Model: ${config.embeddingModel}`);
            if (config.ollamaDimension) {
                console.log(`[MCP]   Ollama Embedding Dimension: ${config.ollamaDimension}`);
            }
            break;
        case 'RabbitMQ':
            console.log(`[MCP]   RabbitMQ URL: ${config.rabbitmqUrl ? '✅ Configured' : '❌ Missing (RABBITMQ_INFERENCE_URL)'}`);
            console.log(`[MCP]   RabbitMQ Queue: ${config.rabbitmqQueue || 'embedding.qwen3-8b (default)'}`);
            console.log(`[MCP]   RabbitMQ Model: ${config.embeddingModel}`);
            console.log(`[MCP]   RabbitMQ Dimension: ${config.rabbitmqDimension ?? 4096}`);
            console.log(`[MCP]   RabbitMQ Priority: ${config.rabbitmqPriority ?? 5}`);
            console.log(`[MCP]   RabbitMQ Concurrency: ${config.rabbitmqConcurrency ?? 10}`);
            console.log(`[MCP]   RabbitMQ Timeout: ${config.rabbitmqTimeoutMs ?? 30000}ms`);
            break;
    }

    console.log(`[MCP] 🔧 Initializing server components...`);
}

export function showHelpMessage(): void {
    console.log(`
Context MCP Server

Usage: npx @zilliz/claude-context-mcp@latest [options]

Options:
  --help, -h                          Show this help message

Environment Variables:
  MCP_SERVER_NAME         Server name
  MCP_SERVER_VERSION      Server version
  
  Embedding Provider Configuration:
  EMBEDDING_PROVIDER      Embedding provider: OpenAI, VoyageAI, Gemini, Ollama, OpenRouter (default: OpenAI)
  EMBEDDING_MODEL         Embedding model name (works for all providers)
  EMBEDDING_DIMENSION     Optional embedding dimension override for Ollama
  
  Provider-specific API Keys:
  OPENAI_API_KEY          OpenAI API key (required for OpenAI provider)
  OPENAI_BASE_URL         OpenAI API base URL (optional, for custom endpoints)
  VOYAGEAI_API_KEY        VoyageAI API key (required for VoyageAI provider)
  GEMINI_API_KEY          Google AI API key (required for Gemini provider)
  GEMINI_BASE_URL         Gemini API base URL (optional, for custom endpoints)
  OPENROUTER_API_KEY      OpenRouter API key (required for OpenRouter provider)

  Ollama Configuration:
  OLLAMA_HOST             Ollama server host (default: http://127.0.0.1:11434)
  OLLAMA_MODEL            Ollama model name (alternative to EMBEDDING_MODEL for Ollama)
  
  Vector Database Configuration:
  MILVUS_ADDRESS          Milvus address (optional, can be auto-resolved from token)
  MILVUS_TOKEN            Milvus token (optional, used for authentication and address resolution)

Examples:
  # Start MCP server with OpenAI (default) and explicit Milvus address
  OPENAI_API_KEY=sk-xxx MILVUS_ADDRESS=localhost:19530 npx @zilliz/claude-context-mcp@latest
  
  # Start MCP server with OpenAI and specific model
  OPENAI_API_KEY=sk-xxx EMBEDDING_MODEL=text-embedding-3-large MILVUS_TOKEN=your-token npx @zilliz/claude-context-mcp@latest
  
  # Start MCP server with VoyageAI and specific model
  EMBEDDING_PROVIDER=VoyageAI VOYAGEAI_API_KEY=pa-xxx EMBEDDING_MODEL=voyage-3-large MILVUS_TOKEN=your-token npx @zilliz/claude-context-mcp@latest
  
  # Start MCP server with Gemini and specific model
  EMBEDDING_PROVIDER=Gemini GEMINI_API_KEY=xxx EMBEDDING_MODEL=gemini-embedding-001 MILVUS_TOKEN=your-token npx @zilliz/claude-context-mcp@latest
  
  # Start MCP server with Ollama and specific model (using OLLAMA_MODEL)
  EMBEDDING_PROVIDER=Ollama OLLAMA_MODEL=mxbai-embed-large MILVUS_TOKEN=your-token npx @zilliz/claude-context-mcp@latest
  
  # Start MCP server with Ollama and specific model (using EMBEDDING_MODEL)
  EMBEDDING_PROVIDER=Ollama EMBEDDING_MODEL=nomic-embed-text MILVUS_TOKEN=your-token npx @zilliz/claude-context-mcp@latest
        `);
} 