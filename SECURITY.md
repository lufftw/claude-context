# Security Policy

## Supported Versions

Security fixes are made on `main` and released in the next `0.1.x-lufftw.N` version. Older versions are not patched; update to the latest release.

## Reporting a Vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion for a suspected vulnerability.

Include the affected version or commit, the configuration involved (embedding provider, Milvus deployment, MCP client), steps to reproduce, and the impact you observed. Do not include real credentials; if a credential was exposed, rotate it before reporting.

Vulnerabilities in upstream code that are not specific to this fork should also be reported to [zilliztech/claude-context](https://github.com/zilliztech/claude-context).

## Scope

In scope: the MCP server, the core indexing library and the scripts in this repository, including how they handle credentials, file system paths, the index snapshot and data sent to embedding providers and Milvus.

Out of scope: vulnerabilities in Milvus, Zilliz Cloud, RabbitMQ, embedding providers or MCP clients themselves; report those to their maintainers.

## What Gets Sent Where

Indexing reads source files under the requested codebase path, excluding ignored and hidden files (see [File Inclusion Rules](docs/dive-deep/file-inclusion-rules.md)). The content of each indexed chunk is sent to the configured embedding provider and stored, with its vector, in Milvus. Choose a self-hosted provider (Ollama or RabbitMQ) and a self-hosted Milvus if source code must not leave your network, and add files containing secrets to `.contextignore`.

## Credentials

Credentials are read only from the environment and must never be committed. See [Credentials and Secret Scanning](docs/lufftw/security-credentials.md) for the policy, the secret scanner and the steps to take after a leak.
