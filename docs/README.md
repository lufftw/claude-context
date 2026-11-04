# Claude Context Documentation
![](../assets/claude-context.png)

Welcome to the Claude Context documentation! Claude Context is a powerful tool that adds semantic code search capabilities to AI coding assistants through MCP.

## 🚀 Quick Navigation

### Getting Started
- [🛠️ Prerequisites](getting-started/prerequisites.md) - What you need before starting
- [🔍 Environment Variables](getting-started/environment-variables.md) - How to configure environment variables for MCP
- [⚡ Quick Start Guide](getting-started/quick-start.md) - Get up and running in 1 minutes


### Components
- [MCP Server](../packages/mcp/README.md) - The MCP server of Claude Context
- [VSCode Extension](../packages/vscode-extension/README.md) - The VSCode extension of Claude Context
- [Core Package](../packages/core/README.md) - The core package of Claude Context

### Dive Deep
- [File Inclusion & Exclusion Rules](dive-deep/file-inclusion-rules.md) - Detailed explanation of file inclusion and exclusion rules
- [Asynchronous Indexing Workflow](dive-deep/asynchronous-indexing-workflow.md) - Detailed explanation of asynchronous indexing workflow

### Fork (lufftw) Documentation
- [Fork Architecture Overview](architecture/fork-overview.md): what this fork adds to upstream, and the invariants it keeps
- [Fork Configuration Reference](reference/fork-configuration.md): fork-only environment variables and how they resolve
- [Credential Handling](security/credential-handling.md): secret policy, automated scanning, incident response
- [Upstream Synchronisation Runbook](maintenance/upstream-sync.md): how to merge new `zilliztech/claude-context` releases
- [Dependency Policy and Version Matrix](maintenance/dependency-policy.md): which library versions the fork uses, and why
- [Design records and bug-fix reports](lufftw/): dated, detailed history of fork changes. Each one carries a status banner where later changes apply
- [Planning documents](plan/): historical; superseded by the records above

_Fork documentation last reviewed in full: 2026-11-04 (`0.1.15-lufftw.2`)._

### Troubleshooting
- [❓ FAQ](troubleshooting/faq.md) - Frequently asked questions
- [🐛 Troubleshooting Guide](troubleshooting/troubleshooting-guide.md) - Troubleshooting guide

## 🔗 External Resources

- [GitHub Repository](https://github.com/zilliztech/claude-context)
- [VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=zilliz.semanticcodesearch)
- [npm - Core Package](https://www.npmjs.com/package/@zilliz/claude-context-core)
- [npm - MCP Server](https://www.npmjs.com/package/@zilliz/claude-context-mcp)
- [Zilliz Cloud](https://cloud.zilliz.com)

## 💬 Support

- **Issues**: [GitHub Issues](https://github.com/zilliztech/claude-context/issues)
- **Discord**: [Join our Discord](https://discord.gg/mKc3R95yE5)
