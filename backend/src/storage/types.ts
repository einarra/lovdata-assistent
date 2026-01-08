// Shared types and utilities for archive storage implementations

export type ArchiveDocument = {
  archiveFilename: string;
  member: string;
  title: string | null;
  date: string | null;
  content: string;
  relativePath: string;
  lawType?: string | null;
  year?: number | null;
  ministry?: string | null;
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

/**
 * Legal term expansions - maps common legal terms to related terms for better search
 */
const LEGAL_TERM_EXPANSIONS: Record<string, string[]> = {
  'ekteskap': ['ekteskapsloven', 'ekteskapsloven', 'ekteskapsrett', 'ekteskapsbrudd'],
  'skjevdeling': ['ekteskapsloven', 'ekteskapsbrudd', 'ekteskapsløsning', 'ekteskapsrett'],
  'ekteskapsløsning': ['ekteskapsloven', 'skjevdeling', 'ekteskapsbrudd'],
  'ekteskapsbrudd': ['ekteskapsloven', 'skjevdeling', 'ekteskapsløsning'],
  'barnebidrag': ['barnebidragsloven', 'underholdsbidrag', 'bidrag'],
  'arverett': ['arveloven', 'arv', 'arving'],
  'arbeidsrett': ['arbeidsmiljøloven', 'arbeidsmiljø', 'arbeidsforhold'],
  'personvern': ['personvernloven', 'gdpr', 'personopplysninger'],
  'kjøpsloven': ['kjøpsloven', 'kjøp', 'kjøpsrett'],
  'forbrukerkjøp': ['forbrukerkjøpsloven', 'forbrukerrett', 'kjøpsloven'],
  'leie': ['husleieloven', 'leieforhold', 'leierett'],
  'husleie': ['husleieloven', 'leie', 'leieforhold'],
  'ansettelse': ['arbeidsmiljøloven', 'ansettelsesforhold', 'arbeidsforhold'],
  'oppsigelse': ['arbeidsmiljøloven', 'oppsigelsesrett', 'oppsigelse'],
  'sykefravær': ['arbeidsmiljøloven', 'sykepenger', 'sykefravær'],
  'mobbing': ['arbeidsmiljøloven', 'diskriminering', 'trakassering'],
  'diskriminering': ['diskrimineringsloven', 'likestillingsloven', 'diskriminering'],
  'likestilling': ['likestillingsloven', 'diskrimineringsloven', 'likestilling'],
};

/**
 * Expands legal terms in query to include related terms for better search recall
 */
export function expandLegalTerms(query: string): string {
  const queryLower = query.toLowerCase();
  const words = queryLower.split(/\s+/);
  const expandedTerms: string[] = [];
  
  for (const word of words) {
    const cleanWord = word.replace(/[^\p{L}\p{N}]/gu, '');
    if (LEGAL_TERM_EXPANSIONS[cleanWord]) {
      expandedTerms.push(...LEGAL_TERM_EXPANSIONS[cleanWord]);
    }
  }
  
  if (expandedTerms.length > 0) {
    // Add expanded terms to query, but keep original query first
    return `${query} ${expandedTerms.join(' ')}`;
  }
  
  return query;
}

