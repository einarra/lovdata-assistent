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
 * Common law name to official title/key identifiers mapping
 * This helps find base laws when searching by common name (e.g., "ekteskapsloven")
 * Maps to key terms that appear in the official law title
 */
const LAW_NAME_TO_OFFICIAL_TITLE: Record<string, string[]> = {
  'ekteskapsloven': ['lov 4. juli 1991 nr. 47 om ekteskap', 'lov 4 juli 1991 nr 47 om ekteskap', '1991 nr 47'],
  'ekteskapslova': ['lov 4. juli 1991 nr. 47 om ekteskap', 'lov 4 juli 1991 nr 47 om ekteskap', '1991 nr 47'],
  'arveloven': ['lov om arv', 'arvelov'],
  'arbeidsmiljøloven': ['lov om arbeidsmiljø', 'arbeidsmiljølov'],
  'barnebidragsloven': ['lov om barnebidrag', 'barnebidragslov'],
  'personvernloven': ['lov om personvern', 'personvernlov'],
  'kjøpsloven': ['lov om kjøp', 'kjøpslov'],
  'forbrukerkjøpsloven': ['lov om forbrukerkjøp', 'forbrukerkjøpslov'],
  'husleieloven': ['lov om husleie', 'husleielov'],
  'diskrimineringsloven': ['lov om diskriminering', 'diskrimineringslov'],
  'likestillingsloven': ['lov om likestilling', 'likestillingslov'],
};

/**
 * Expands legal terms in query to include related terms for better search recall
 * Also maps common law names (e.g., "ekteskapsloven") to official titles/key identifiers
 */
export function expandLegalTerms(query: string): string {
  const queryLower = query.toLowerCase();
  const words = queryLower.split(/\s+/);
  const expandedTerms: string[] = [];
  const officialTitleTerms: string[] = [];
  
  for (const word of words) {
    const cleanWord = word.replace(/[^\p{L}\p{N}]/gu, '');
    
    // Check for legal term expansions
    if (LEGAL_TERM_EXPANSIONS[cleanWord]) {
      expandedTerms.push(...LEGAL_TERM_EXPANSIONS[cleanWord]);
    }
    
    // Check for common law name to official title mapping
    // This helps find base laws when searching by common name
    if (LAW_NAME_TO_OFFICIAL_TITLE[cleanWord]) {
      officialTitleTerms.push(...LAW_NAME_TO_OFFICIAL_TITLE[cleanWord]);
    }
  }
  
  // Build expanded query: original + expanded terms + official title terms
  const parts: string[] = [query];
  if (expandedTerms.length > 0) {
    parts.push(...expandedTerms);
  }
  if (officialTitleTerms.length > 0) {
    parts.push(...officialTitleTerms);
  }
  
  return parts.join(' ');
}

