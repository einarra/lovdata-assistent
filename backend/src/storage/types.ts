// Shared types and utilities for archive storage implementations

export type ArchiveDocument = {
  archiveFilename: string;
  member: string;
  title: string | null;
  date: string | null;
  content: string;
  relativePath: string;
};

export type ArchiveIngestSession = {
  addDocument(doc: ArchiveDocument): void;
  finalize(): void;
  discard(error?: unknown): void;
};

export type ArchiveSearchHit = {
  filename: string;
  member: string;
  title: string | null;
  date: string | null;
  snippet: string;
};

export type ArchiveSearchResult = {
  hits: ArchiveSearchHit[];
  total: number;
};

export type ArchiveDocumentRecord = {
  content: string;
  title: string | null;
  date: string | null;
  relativePath: string | null;
};

export function extractQueryTokens(queryLower: string): string[] {
  const raw = queryLower.match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  const unique = Array.from(new Set(raw));
  return unique.filter(token => token.length >= 3);
}

