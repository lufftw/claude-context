# Environment Variables Configuration

## 🎯 Global Configuration

Claude Context supports a global configuration file at `~/.context/.env` to simplify MCP setup across different MCP clients.

**Benefits:**
- Configure once, use everywhere
- No need to specify environment variables in each MCP client
- Cleaner MCP configurations

## 📋 Environment Variable Priority

1. **Project `.env`** in the root of the codebase being indexed or searched (highest — *lufftw fork*)
2. **Process Environment Variables** (the MCP client's `env` block and the OS environment)
3. **Global Configuration File** (`~/.context/.env`)
4. **Default Values** (lowest)

> **Project `.env` (lufftw fork).** When a tool call targets a codebase, a `.env` file in that codebase's root is read for that call only, so one MCP server can serve several projects with different collections or models. The scope is per call (AsyncLocalStorage), so parallel indexing jobs never see each other's values. See [Project-scoped `.env` loading](../lufftw/project-env-loading.md).
>
> Exception: `CLAUDE_CONTEXT_HOME` is read from the process environment only, because it decides where the shared state lives before any project is known.

## 🔧 Required Environment Variables

### Embedding Provider
| Variable | Description | Default |
|----------|-------------|---------|
| `EMBEDDING_PROVIDER` | Provider: `OpenAI`, `VoyageAI`, `Gemini`, `Ollama`, `OpenRouter`, `RabbitMQ` (*lufftw fork*) | `OpenAI` |
| `EMBEDDING_MODEL` | Embedding model name (works for all providers) | Provider-specific default |
| `OPENAI_API_KEY` | OpenAI API key | Required for OpenAI |
| `OPENAI_BASE_URL` | OpenAI API base URL (optional, for custom endpoints) | `https://api.openai.com/v1` |
| `VOYAGEAI_API_KEY` | VoyageAI API key | Required for VoyageAI |
| `GEMINI_API_KEY` | Gemini API key | Required for Gemini |
| `GEMINI_BASE_URL` | Gemini API base URL (optional, for custom endpoints) | `https://generativelanguage.googleapis.com/v1beta` |
| `OPENROUTER_API_KEY` | OpenRouter API key (uses OpenRouter's OpenAI-compatible endpoint) | Required for OpenRouter |

> **💡 Note:** `EMBEDDING_MODEL` is a universal environment variable that works with all embedding providers. Simply set it to the model name you want to use (e.g., `text-embedding-3-large` for OpenAI, `voyage-code-3` for VoyageAI, etc.).

> **Supported Model Names:**
> 
> - OpenAI Models: See `getSupportedModels` in [`openai-embedding.ts`](https://github.com/zilliztech/claude-context/blob/master/packages/core/src/embedding/openai-embedding.ts) for the full list of supported models.
> 
> - VoyageAI Models: See `getSupportedModels` in [`voyageai-embedding.ts`](https://github.com/zilliztech/claude-context/blob/master/packages/core/src/embedding/voyageai-embedding.ts) for the full list of supported models.
> 
> - Gemini Models: See `getSupportedModels` in [`gemini-embedding.ts`](https://github.com/zilliztech/claude-context/blob/master/packages/core/src/embedding/gemini-embedding.ts) for the full list of supported models.
> 
> - Ollama Models: Depends on the model you install locally.

> **📖 For detailed provider-specific configuration examples and setup instructions, see the [MCP Configuration Guide](../../packages/mcp/README.md#embedding-provider-configuration).**

### Vector Database
| Variable | Description | Default |
|----------|-------------|---------|
| `MILVUS_TOKEN` | Milvus authentication token. Get [Zilliz Personal API Key](https://github.com/zilliztech/claude-context/blob/master/assets/signup_and_get_apikey.png) | Recommended |
| `MILVUS_ADDRESS` | Milvus server address. Optional when using Zilliz Personal API Key | Auto-resolved from token |
| `MILVUS_COLLECTION_LIMIT_CHECK_TIMEOUT_MS` | Timeout for gRPC pre-check in `checkCollectionLimit()` before indexing begins | `15000` |

### Ollama (Optional)
| Variable | Description | Default |
|----------|-------------|---------|
| `OLLAMA_HOST` | Ollama server URL | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL`(alternative to `EMBEDDING_MODEL`) | Model name |  |
| `EMBEDDING_DIMENSION` | Output dimension passed to Ollama (positive integer) | Model default |


### Advanced Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `HYBRID_MODE` | Enable hybrid search (BM25 + dense vector). Set to `false` for dense-only search | `true` |
| `EMBEDDING_BATCH_SIZE` | Batch size for processing. Larger batch size means less indexing time | `100` |
| `SPLITTER_TYPE` | Code splitter type: `ast`, `langchain` | `ast` |
| `CUSTOM_EXTENSIONS` | Additional file extensions to include (comma-separated, e.g., `.vue,.svelte,.astro`) | None |
| `CUSTOM_IGNORE_PATTERNS` | Additional ignore patterns (comma-separated, e.g., `temp/**,*.backup,private/**`) | None |
| `CODE_CHUNKS_COLLECTION_NAME_OVERRIDE` | Optional custom prefix for collection names. Produces `code_chunks_<suffix>_<pathHash>` or `hybrid_code_chunks_<suffix>_<pathHash>` after sanitization. The path hash stays appended so collections remain unique per codebase even when the override is set | None |

When `CODE_CHUNKS_COLLECTION_NAME_OVERRIDE` is set, Claude Context writes to an override-named collection instead of the default `code_chunks_<pathHash>`. The per-codebase `<pathHash>` suffix is preserved to keep multiple codebases distinct under the same override. If you later unset the variable, Claude Context returns to the plain hash-based naming for that path.

### MCP Server and Background Sync
| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_CONTEXT_BACKGROUND_SYNC` | Run the startup sync and the periodic sync of indexed codebases. `false` disables polling; trigger-file syncs still work | `true` |
| `CLAUDE_CONTEXT_SYNC_INTERVAL_MS` | Interval of the periodic sync, in milliseconds (minimum `1000`) | `300000` (5 min) |
| `CLAUDE_CONTEXT_TRIGGER_WATCHER` | Watch `~/.context/.sync-trigger`; touching it starts an immediate, debounced re-index. Set `false` on read-only or sandboxed filesystems | `true` |
| `CLAUDE_CONTEXT_SYNC_LOCK_STALE_MS` | Age after which the cross-process sync lock (`~/.context/mcp-sync.lock`) is considered stale | `600000` (10 min) |
| `MCP_SERVER_NAME` | Server name reported to the MCP client | `Context MCP Server` |
| `MCP_SERVER_VERSION` | Server version reported to the MCP client | Version from `package.json` |
| `ZILLIZ_BASE_URL` | Zilliz Cloud control-plane URL used to resolve the address from a token | `https://api.cloud.zilliz.com` |

See [Trigger File Watcher](../../packages/mcp/README.md#trigger-file-watcher-optional) in the MCP README for a Claude Code hook that touches the trigger file.

## 🧩 lufftw Fork Configuration

The variables below exist only in this fork. All of them may be set in a project `.env`, except `CLAUDE_CONTEXT_HOME`. For an overview of the fork, see [docs/lufftw](../lufftw/README.md).

### RabbitMQ Embedding Provider
Set `EMBEDDING_PROVIDER=RabbitMQ` to send embedding requests over RPC to self-hosted inference workers instead of a cloud API. Details: [RabbitMQ embedding provider](../lufftw/rabbitmq-embedding-provider.md).

| Variable | Description | Default |
|----------|-------------|---------|
| `RABBITMQ_INFERENCE_URL` | Full AMQP URL including credentials and vhost, e.g. `amqp://user:pass@host:5672/inference`. **Keep it out of git** (see [Credentials](../lufftw/security-credentials.md)) | Required |
| `RABBITMQ_EMBEDDING_QUEUE` | Work queue the primary model's worker consumes | `embedding.qwen3-8b` |
| `EMBEDDING_MODEL` | Logical model name sent in the task body | `qwen3-embedding-8b` |
| `RABBITMQ_EMBEDDING_DIMENSION` | Vector dimension the worker returns (also the collection dimension). Replies with another dimension are rejected | `4096` |
| `RABBITMQ_EMBEDDING_TIMEOUT_MS` | Per-request liveness timeout | `1700000` (≈28 min) |
| `RABBITMQ_EMBEDDING_MAX_RETRIES` | Re-publish attempts for transient (WAIT-class) faults. Keep `timeout × (retries + 1)` below the broker's `consumer_timeout` | `3` |
| `RABBITMQ_EMBEDDING_PRIORITY` | Message priority, `0`–`10` | `5` |
| `RABBITMQ_EMBEDDING_CONCURRENCY` | Parallel in-flight requests per batch | `10` |
| `RABBITMQ_EMBEDDING_SOURCE` | `source` field written into each task | `claude-context` |

### Dual Embedding (Secondary Model)
An optional second, smaller model indexed into its own collection. It is off unless `MILVUS_COLLECTION_PRIVATE_0P6B` is set, and it requires `EMBEDDING_PROVIDER=RabbitMQ`. Design: [Dual embedding](../lufftw/design-2026-06-14-dual-embedding.md).

| Variable | Description | Default |
|----------|-------------|---------|
| `MILVUS_COLLECTION_PRIVATE_0P6B` | **Activation switch.** Collection for the secondary model's vectors | Unset (secondary off) |
| `RABBITMQ_SECONDARY_MODEL` | Canonical id of the secondary model | `qwen3-embedding-0.6b` |
| `RABBITMQ_SECONDARY_QUEUE` | Queue of the secondary worker | `embedding.qwen3-0.6b` |
| `RABBITMQ_SECONDARY_DIMENSION` | Secondary vector dimension | `1024` |
| `SEARCH_EMBEDDING_MODEL` | Default model for `search_code` when the call does not pass `embeddingModel` | `qwen3-embedding-8b` |
| `COVERAGE_READABLE_THRESHOLD` | Minimum coverage (0–1) of the secondary collection, measured as the share of the primary collection's chunks it also holds, before searches may use it; below it, search returns a structured "degraded" notice | `0.85` |

### Collections and Shared State
Details: [Private + shared collections](../lufftw/private-shared-collections.md).

| Variable | Description | Default |
|----------|-------------|---------|
| `MILVUS_COLLECTION_PRIVATE` | Exact collection name for this codebase. Takes precedence over `CODE_CHUNKS_COLLECTION_NAME_OVERRIDE` and the hash-based name | Hash-based name |
| `MILVUS_COLLECTION_SHARED` | Additional collection searched alongside the private one (results merged by score; tagged `[shared]`) | Unset |
| `MILVUS_STRATEGY` | `hybrid`: search private + shared. `private`: ignore `MILVUS_COLLECTION_SHARED` | Unset (shared is searched when set) |
| `MILVUS_WRITABLE_SHARED` | When set, indexing also writes every chunk to this collection, reusing the same embedding (no extra embedding cost) | Unset |
| `CLAUDE_CONTEXT_HOME` | Directory holding the index snapshot (`mcp-codebase-snapshot.json`); point several users or machines at the same directory to share index state. **Process environment only** | `~/.context` |
| `MILVUS_AUTOLOAD_DENY` | Collections (comma/space separated, `*` wildcard) that search must not load implicitly, so a released large collection stays released. Searching a denied, unloaded collection fails loudly | Unset (all may load) |

### Indexing Reliability
| Variable | Description | Default |
|----------|-------------|---------|
| `INDEX_MAX_CONSECUTIVE_ERRORS` | Consecutive batches with hard (REAL-class) failures after which indexing of the primary model aborts; a failing secondary model is dropped instead. Transient (WAIT-class) failures never count | `3` |

If the primary model stores no chunk at all during a run and at least one hard failure occurred, indexing fails with an `EmbeddingError` that includes the provider's last error, instead of reporting an empty index as complete.

## 🚀 Quick Setup

### 1. Create Global Config
```bash
mkdir -p ~/.context
cat > ~/.context/.env << 'EOF'
EMBEDDING_PROVIDER=OpenAI
OPENAI_API_KEY=sk-your-openai-api-key
EMBEDDING_MODEL=text-embedding-3-small
MILVUS_ADDRESS=your-zilliz-cloud-public-endpoint
MILVUS_TOKEN=your-zilliz-cloud-api-key
EOF
```

See the [Example File](../../.env.example) for more details.

### 2. Simplified MCP Configuration

**Claude Code:**
```bash
claude mcp add claude-context \
  -e OPENAI_API_KEY=sk-your-openai-api-key \
  -e MILVUS_ADDRESS=your-zilliz-cloud-public-endpoint \
  -e MILVUS_TOKEN=your-zilliz-cloud-api-key \
  -- npx @zilliz/claude-context-mcp@latest
```

**Cursor/Windsurf/Others:**
```json
{
  "mcpServers": {
    "claude-context": {
      "command": "npx",
      "args": ["-y", "@zilliz/claude-context-mcp@latest"]
    }
  }
}
```

## 📚 Additional Information

For detailed information about file processing rules and how custom patterns work, see:
- [What files does Claude Context decide to embed?](../troubleshooting/faq.md#q-what-files-does-claude-context-decide-to-embed)
 
