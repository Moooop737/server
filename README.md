# server

English | [简体中文](README.zh-CN.md)

A local-first RAG (retrieval-augmented generation) backend built with [Hono](https://hono.dev) on Node.js. It archives and ingests documents, runs hybrid (vector + BM25) retrieval over them, answers questions through a tool-calling chat agent, and records traces and evaluation runs.

## Features

- **Resources**: upload files (presigned S3 PUT), archive URLs or pasted text, then parse, chunk and embed them. Supports soft delete, restore, purge and aborting an in-flight ingest.
- **Codebases**: upload a ZIP, browse its file tree, preview or download single files.
- **Retrieval**: `POST /retrieve` runs vector search (pgvector HNSW) and lexical search (ParadeDB BM25) and fuses them with RRF.
- **Chat**: `POST /chat` streams answers as a UI message stream; the model decides when to call the retrieval tool. Sessions and messages are stored in Postgres.
- **Models**: chat and embedding models from DeepSeek, DashScope, Ollama, SiliconFlow or any OpenAI-compatible endpoint, addressed as `provider:modelId`.
- **Observability**: per-request traces and stages in Postgres, LLM traces in Langfuse.
- **Evaluation**: datasets, cases, configs and runs under `/eval`, optionally in a separate database.
- **API docs**: Scalar reference at `/doc`, raw OpenAPI spec at `/doc/openapi.json`.

## Requirements

- Node.js (a version that supports `--env-file`)
- PostgreSQL with the `vector` (pgvector) and `pg_search` (ParadeDB) extensions
- [dbmate](https://github.com/amacneil/dbmate) for migrations
- S3-compatible object storage, for example MinIO
- Ollama, or an API key for one of the hosted model providers
- Optional: Langfuse for LLM tracing

## Getting started

```bash
npm install
# create .env (see Configuration below)
dbmate up          # applies db/migrations
npm run dev        # watch mode; or `npm start`
```

The server listens on `http://127.0.0.1:$PORT` (default port `3000`). Open `/doc` for the API reference and `/health` to check that the database, object storage and model services are reachable.

## Configuration

Settings are read from `.env`. Missing required values or invalid values stop the server at startup with `E_CONFIG_MISSING` or `E_CONFIG_INVALID`.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | | Main Postgres connection string |
| `OLLAMA_BASE_URL` | yes | | Ollama base URL |
| `EMBEDDING_MODEL` | yes | | Embedding model, `provider:modelId` |
| `CHAT_MODEL` | yes | | Default chat model, `provider:modelId` |
| `S3_ENDPOINT` | yes | | Object storage endpoint, must be the host the browser uses (it is signed into presigned URLs) |
| `S3_BUCKET` | yes | | Bucket name |
| `S3_ACCESS_KEY_ID` | yes | | Access key |
| `S3_SECRET_ACCESS_KEY` | yes | | Secret key |
| `S3_REGION` | | `us-east-1` | Region |
| `S3_FORCE_PATH_STYLE` | | `true` | Path-style addressing |
| `PORT` | | `3000` | HTTP port (host is always `127.0.0.1`) |
| `EMBEDDING_DIMENSIONS` | | `1024` | Embedding size; 512, 1024 and 2048 have HNSW indexes |
| `RETRIEVAL_VECTOR_TOPK` | | `10` | Vector search candidates |
| `RETRIEVAL_LEXICAL_TOPK` | | `10` | BM25 search candidates |
| `RETRIEVAL_MIN_SIMILARITY` | | `0.42` | Minimum cosine similarity |
| `RETRIEVAL_RRF_K` | | `60` | RRF constant |
| `RETRIEVAL_DEFAULT_LIMIT` | | `6` | Fused results returned by default |
| `EVAL_DATABASE_URL` | | | Separate evaluation database; unset means evaluation shares the main database |
| `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`, `SILICONFLOW_API_KEY`, `ROUTER1_API_KEY`, `ROUTER1_END_POINT` | | | Provider credentials; a provider without its key is not registered |
| `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | | | Langfuse tracing |

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start with file watching |
| `npm start` | Start |
| `npm test` | Run tests with Vitest |
| `npm run test:ui` | Vitest UI |
| `npm run db:schema` | Regenerate `src/adapter/repo/orm/schema.ts` from the database (drizzle-kit introspect) |
| `npm run eval:db:setup` | Create and migrate the separate evaluation database |
| `npm run eval:seed` | Copy ready resources from the main database into the evaluation database |
| `npm run eval:cases:import` | Import `scripts/eval-cases.json` into the evaluation dataset |
| `npm run eval:probe` | Run retrieval against sample questions and print hit metrics |
| `npm run cleanup:test` | Delete test data |

## Database

Migrations live in `db/migrations` and are applied with dbmate; dbmate is the source of truth. `drizzle.config.ts` exists only for `npm run db:schema`: do not run `drizzle-kit generate` or `push` with it.

## Project layout

```text
src/
  index.ts      entry point and route wiring
  config.ts     environment loading and validation
  routes/       HTTP routes
  adapter/      database, object storage and model providers
  ingest/       fetch, parse, chunk and embed
  retrieve/     vector, lexical and fusion retrieval
  agent/        chat agent, prompts and tools
  resource/     resource lifecycle
  codebase/     codebase ZIP archive and reader
  eval/         evaluation runner, metrics and judge
  trace/        request traces and Langfuse
db/migrations/  dbmate migrations
scripts/        maintenance and evaluation scripts
test/           tests
```
