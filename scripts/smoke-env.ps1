# Smoke-test environment — OpenAI default mode
# Used by scripts/run-smoke.ps1 for harness invocations.
# Smoke does not exercise live embed calls; provider-specific eager-init paths NOT covered.
$env:CLAUDE_CONTEXT_HOME = 'E:\tmp\upgrade-smoke-context'
$env:EMBEDDING_PROVIDER = 'OpenAI'
$env:OPENAI_API_KEY = 'sk-smoke-fake-do-not-use'
$env:MILVUS_ADDRESS = '127.0.0.1:19530'
$env:MILVUS_TOKEN = 'smoke-token'
