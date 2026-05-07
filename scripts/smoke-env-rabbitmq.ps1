# Smoke-test environment — RabbitMQ provider mode
# Used by scripts/run-smoke.ps1 -RabbitMQ for RabbitMQ-mode harness invocations.
# Intentional bad RabbitMQ host/queue; smoke must remain lazy and not connect.
$env:CLAUDE_CONTEXT_HOME = 'E:\tmp\upgrade-smoke-context'
$env:EMBEDDING_PROVIDER = 'RabbitMQ'
$env:RABBITMQ_INFERENCE_URL = 'amqp://noop:noop@127.0.0.1:1/inference'
$env:RABBITMQ_EMBEDDING_QUEUE = 'qwen3.embed.smoke.noop'
$env:MILVUS_ADDRESS = '127.0.0.1:19530'
$env:MILVUS_TOKEN = 'smoke-token'
