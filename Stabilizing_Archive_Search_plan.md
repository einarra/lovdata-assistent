## Stabilizing Archive Search Pipeline

- **Pre-extract archives once to disk**  
  Run a CLI job (or startup task) that downloads each archive, streams it to a temp directory, and writes individual XML files. No more per-request decompression.

- **Persist metadata in SQLite**  
  As you extract, insert rows (`filename`, `member`, `title`, `date`, `snippet`, `path`). Add a simple full-text index on the snippet/body column (SQLite FTS5 works fine).

                You can now refresh the archive index at any time by running: npm run reindex

- **Query SQLite instead of scanning archives**  
  In `searchLovdataPublicData`, swap the tar iteration for a parameterized FTS query. The DB returns matching documents with file paths you can hydrate on demand.

- **Limit memory usage**  
  Drop the global `archiveCache` and read file contents only when needed. Use streaming reads (no full file load) when building snippets.

- **Incremental updates**  
  Store the archive’s modified timestamp in SQLite. A lightweight watcher or cron job can re-run the extractor only when a newer archive appears.

This keeps the solution local and simple—no vector DB—while removing repeated decompression, bounding memory consumption, and improving search latency.

