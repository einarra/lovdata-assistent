# Plan: Agent-Directed Lovdata Search with Prioritized Law Types

## Overview
Transform the lovdata-api skill to be directly callable by the OpenAI agent using function calling, allowing the agent to intelligently query legal documents based on user questions with prioritized law type filtering.

## Current Architecture
- The skill is currently called **before** the agent receives evidence
- Search parameters are hardcoded in `assistant.ts` (line 119-128)
- Flow: User Question → Skill Execution (hardcoded search) → Evidence → Agent → Answer
- Agent only receives pre-searched evidence and generates answers
- No function calling capability exists
- Agent has no control over search parameters

## Target Architecture
- **Agent receives user question first** (no pre-search)
- Agent can call the lovdata-api skill directly via OpenAI function calling
- Agent intelligently extracts search parameters (query, lawType, year, ministry) from user question
- Agent follows law type priority: Lov → Forskrift → Vedtak → Instruks → Reglement → Vedlegg
- Agent can make multiple search calls if initial search doesn't return sufficient results
- Flow: User Question → Agent → Function Call (skill) → Results → Agent → Answer

## Important Architectural Change
⚠️ **This is a breaking change to the current flow.** The agent will now be responsible for:
1. Deciding when to search
2. Extracting search parameters from the question
3. Calling the search function
4. Evaluating search results
5. Deciding if additional searches are needed
6. Generating the final answer with HTML links to documents

## Additional Requirements
- **Include lovdata-serper skill** as a function the agent can call for finding:
  - Detailed information about laws and regulations
  - From court decisions (rettsavgjørelser)
  - How laws and regulations are used in practice in the legal system
- **Restrict serper searches** to only lovdata.no with specific URL patterns:
  - inurl:/avgjørelser/
  - inurl:/lovtidend/
  - inurl:/husleietvistutvalget/
  - inurl:/trygderetten/
  - inurl:/sph2025/
- **Disable Cohere reranking** for agent-directed searches (not relevant anymore)
- **Agent must provide citations with HTML links** to all relevant documents used
- Evidence should include both lovdata-api and lovdata-serper results

## Implementation Plan

### Phase 1: Add Function Calling Infrastructure

#### 1.1 Create Function/Tool Schema Definitions
**File:** `backend/src/skills/lovdata-api/functionSchema.ts` (new file)  
**File:** `backend/src/skills/lovdata-serper/functionSchema.ts` (new file)

Define OpenAI function calling schemas for both skills:

**lovdata-api function schema:**
```typescript
export const lovdataSearchFunction = {
  name: 'search_lovdata_legal_documents',
  description: `Søk gjennom Lovdata juridiske dokumenter. Bruk denne funksjonen for å finne lover, forskrifter, vedtak og andre juridiske dokumenter basert på brukerens spørsmål. 
  
Prioritering av dokumenttyper (søk i denne rekkefølgen hvis brukerens spørsmål ikke spesifiserer type):
1. Lov (lover/acts) - høyest prioritet
2. Forskrift (regulations)
3. Vedtak (decisions)
4. Instruks (instructions)
5. Reglement (regulations/regulations)
6. Vedlegg (annexes) - lavest prioritet

VIKTIG: Søk alltid gjennom dokumenttype Lov og Forskrift først. Hvis du ikke finner tilstrekkelige resultater med en dokumenttype, prøv neste type i prioritetsrekkefølgen.`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Søkeordene basert på brukerens spørsmål. Ekstraher relevante juridiske termer.'
      },
      lawType: {
        type: 'string',
        enum: ['Lov', 'Forskrift', 'Vedtak', 'Instruks', 'Reglement', 'Vedlegg'],
        description: 'Dokumenttype. Hvis ikke spesifisert i spørsmålet, start med "Lov" og "Forskrift" og prøv andre typer hvis nødvendig.'
      },
      year: {
        type: 'number',
        description: 'År for dokumentet (hvis nevnt i spørsmålet, f.eks. "2023", "fra 2020")'
      },
      ministry: {
        type: 'string',
        description: 'Departement (hvis nevnt i spørsmålet, f.eks. "Justisdepartementet", "Helse- og omsorgsdepartementet")'
      },
      page: {
        type: 'number',
        description: 'Sidenummer (start med 1)',
        default: 1
      },
      pageSize: {
        type: 'number',
        description: 'Antall resultater per side (maks 20)',
        default: 10
      }
    },
    required: ['query']
  }
};

export const lovdataSerperFunction = {
  name: 'search_lovdata_legal_practice',
  description: `Søk gjennom Lovdata.no for å finne utdypende informasjon om lover og forskrifter fra rettsavgjørelser, rettspraksis og praktisk anvendelse i rettssystemet. 

Bruk denne funksjonen når du trenger:
- Rettsavgjørelser og dommer som illustrerer hvordan lover og forskrifter anvendes
- Praktiske eksempler på tolking og anvendelse av lovtekster
- Kontekst om hvordan rettsregler brukes i praksis
- Tilleggsinformasjon fra Lovtidend, Trygderetten, Husleietvistutvalget og lignende kilder

Denne funksjonen søker kun på lovdata.no og begrenser søket til spesifikke dokumenttyper:
- Rettsavgjørelser (/avgjørelser/)
- Lovtidend (/lovtidend/)
- Husleietvistutvalget (/husleietvistutvalget/)
- Trygderetten (/trygderetten/)
- State Personnel Handbook 2025 (/sph2025/)

Bruk denne i kombinasjon med search_lovdata_legal_documents for å gi både lovtekster og praktiske eksempler.`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Søkeordene basert på brukerens spørsmål. Fokuser på juridiske termer, lovnavn eller emner du vil finne praksis for.'
      },
      num: {
        type: 'number',
        description: 'Antall resultater (maks 20, standard 10)',
        default: 10,
        minimum: 1,
        maximum: 20
      }
    },
    required: ['query']
  }
};
```

#### 1.2 Extend Agent Types for Function Calling
**File:** `backend/src/agents/types.ts`

Add function calling support:
```typescript
export type AgentFunctionCall = {
  name: string;
  arguments: string; // JSON string
};

export type AgentFunctionResult = {
  name: string;
  result: unknown;
};

export type AgentInputWithFunctions = AgentInput & {
  functions?: Array<{
    name: string;
    description?: string;
    parameters: object;
  }>;
  functionResults?: AgentFunctionResult[];
};
```

#### 1.3 Update OpenAI Agent to Support Function Calling
**File:** `backend/src/agents/openAIAgent.ts`

- Add function definitions to OpenAI API call
- Handle function call responses
- Execute functions and return results
- Continue conversation with function results

**Key changes:**
- Modify `generate()` method to accept optional functions parameter
- Update OpenAI chat completion call to include `tools` parameter
- Handle `tool_calls` in response
- Return function call requests for execution

### Phase 2: Update Lovdata-API Skill for Prioritized Search

#### 2.1 Add Prioritized Search Logic
**File:** `backend/src/skills/lovdata-api/index.ts`

**Option A: Implement prioritized search in the skill (recommended)**
This handles prioritization at the skill level, so the agent can request one search and get prioritized results.

```typescript
// In execute() function, update searchPublicData case:
case 'searchPublicData': {
  // ... existing code ...
  
  // NEW: If lawType is not specified, use prioritized search
  const usePrioritizedSearch = !command.filters?.lawType;
  const defaultLawTypePriority = ['Lov', 'Forskrift', 'Vedtak', 'Instruks', 'Reglement', 'Vedlegg'];
  
  let searchResult: LovdataSearchResult;
  
  if (usePrioritizedSearch) {
    // Try each law type in priority order until we get sufficient results
    const minResults = Math.max(3, Math.floor(pageSize * 0.5)); // Require at least 50% of requested results
    let bestResult: LovdataSearchResult | null = null;
    let searchedTypes: string[] = [];
    
    for (const lawType of defaultLawTypePriority) {
      const typeResult = await searchLovdataPublicData({
        store: archiveStore,
        query: command.query,
        page,
        pageSize,
        filters: {
          ...command.filters,
          lawType
        }
      });
      
      searchedTypes.push(lawType);
      
      // Track the best result so far
      if (!bestResult || (typeResult.hits?.length ?? 0) > (bestResult.hits?.length ?? 0)) {
        bestResult = typeResult;
      }
      
      // If we got enough results, use this type
      if (typeResult.hits && typeResult.hits.length >= minResults) {
        searchResult = {
          ...typeResult,
          meta: { 
            ...typeResult.meta, 
            searchedLawTypes: [lawType],
            prioritizedSearch: true
          }
        };
        break;
      }
    }
    
    // If no single type gave enough results, return the best we found
    if (!searchResult && bestResult) {
      searchResult = {
        ...bestResult,
        meta: {
          ...bestResult.meta,
          searchedLawTypes: searchedTypes,
          prioritizedSearch: true,
          allTypesSearched: true
        }
      };
    } else if (!searchResult) {
      // Fallback: search without law type filter
      searchResult = await searchLovdataPublicData({
        store: archiveStore,
        query: command.query,
        page,
        pageSize,
        filters: command.filters
      });
    }
  } else {
    // Law type specified, use normal search
    searchResult = await searchLovdataPublicData({
      store: archiveStore,
      query: command.query,
      page,
      pageSize,
      filters: command.filters
    });
  }
  
  // ... rest of existing code (fallback, return, etc.) ...
}
```

**Option B: Let agent handle prioritization (simpler but requires multiple function calls)**
Agent makes multiple function calls, trying each law type sequentially. This is simpler to implement but results in more API calls.

**Recommendation:** Use Option A - it's more efficient and reduces API calls while still giving the agent control.

#### 2.2 Update Skill Input to Support Function Calling Format
**File:** `backend/src/skills/lovdata-api/index.ts`

Update `normalizeInput()` to handle function call arguments:
- Parse JSON arguments from function calls
- Map function parameters to skill input format
- Support both old format (for backward compatibility) and new function calling format

### Phase 3: Integrate Function Calling into Assistant Flow

#### 3.1 Update Assistant Service
**File:** `backend/src/services/assistant.ts`

**Major changes:**
1. Remove hardcoded skill execution (lines 117-134)
2. Add function definitions to agent input
3. Handle agent function calls in a loop
4. Execute functions (skills) based on agent requests
5. Feed function results back to agent
6. Repeat until agent has enough information to answer (max iterations to prevent loops)

**New flow:**
```
User Question → Agent (with function definitions) 
  → Agent decides to call search_lovdata_legal_documents
  → Execute skill with agent's parameters
  → Return results to agent
  → Agent evaluates: sufficient results? → Yes: Generate answer | No: Try next law type
  → Agent generates final answer based on search results
```

**Implementation structure:**
```typescript
// In assistant.ts
async function runAssistant(options: AssistantRunOptions) {
  // ... setup code ...
  
  // NEW: Prepare function definitions (both skills)
  const functions = [
    lovdataSearchFunction,      // From lovdata-api/functionSchema.ts
    lovdataSerperFunction       // From lovdata-serper/functionSchema.ts
  ];
  const orchestrator = await getOrchestrator();
  const services = getServices();
  
  // NEW: Agent-driven search loop
  let agentEvidence: AgentEvidence[] = [];
  let agentOutput: AgentOutput | null = null;
  let usedAgent = false;
  const maxAgentIterations = 5; // Prevent infinite loops
  const functionResults: AgentFunctionResult[] = [];
  
  for (let iteration = 0; iteration < maxAgentIterations; iteration++) {
    // Call agent with current evidence and functions
    const agentInput: AgentInputWithFunctions = {
      question: options.question,
      evidence: agentEvidence,
      locale: options.locale,
      functions: functions,
      functionResults: functionResults // Results from previous iterations
    };
    
    const agentResult = await agent.generate(agentInput);
    
    // Check if agent wants to call a function
    if (agentResult.functionCalls && agentResult.functionCalls.length > 0) {
      for (const functionCall of agentResult.functionCalls) {
        if (functionCall.name === 'search_lovdata_legal_documents') {
          // Execute lovdata-api skill with agent's parameters
          const searchParams = JSON.parse(functionCall.arguments);
          const skillResult = await orchestrator.run(
            {
              input: {
                action: 'searchPublicData',
                query: searchParams.query,
                lawType: searchParams.lawType,
                year: searchParams.year,
                ministry: searchParams.ministry,
                page: searchParams.page || 1,
                pageSize: searchParams.pageSize || 10
              }
            },
            { services, now: new Date(), scratch: {}, agentCall: true }
          );
          
          // Convert skill results to evidence format
          const newEvidence = convertLovdataSkillResultsToEvidence(skillResult.result.hits);
          agentEvidence = [...agentEvidence, ...newEvidence];
          functionResults.push({ name: functionCall.name, result: skillResult.result });
        } else if (functionCall.name === 'search_lovdata_legal_practice') {
          // Execute lovdata-serper skill with agent's parameters
          const searchParams = JSON.parse(functionCall.arguments);
          const skillResult = await orchestrator.run(
            {
              input: {
                action: 'search',
                query: searchParams.query,
                num: searchParams.num || 10,
                site: 'lovdata.no'
              },
              hints: { preferredSkill: 'lovdata-serper' }
            },
            { services, now: new Date(), scratch: {}, agentCall: true }
          );
          
          // Convert serper results to evidence format
          const serperResult = skillResult.result as { organic?: Array<{ title?: string | null; link?: string | null; snippet?: string | null; date?: string | null }> };
          const newEvidence = convertSerperResultsToEvidence(serperResult.organic ?? []);
          agentEvidence = [...agentEvidence, ...newEvidence];
          functionResults.push({ name: functionCall.name, result: skillResult.result });
        }
      }
      // Continue loop to let agent process new evidence
      continue;
    } else {
      // Agent has final answer
      agentOutput = agentResult;
      usedAgent = true;
      break;
    }
  }
  
  // ... rest of response building ...
}

// Helper functions to convert skill results to evidence
function convertLovdataSkillResultsToEvidence(hits: any[]): AgentEvidence[] {
  return hits.map((hit, index) => ({
    id: `lovdata-${index + 1}`,
    source: 'lovdata',
    title: hit.title ?? hit.filename ?? 'Uten tittel',
    snippet: hit.snippet,
    date: hit.date ?? null,
    link: buildXmlViewerUrl(hit.filename, hit.member),
    metadata: {
      filename: hit.filename,
      member: hit.member
    }
  }));
}

function convertSerperResultsToEvidence(organic: Array<{ title?: string | null; link?: string | null; snippet?: string | null; date?: string | null }>): AgentEvidence[] {
  return organic.map((item, index) => ({
    id: `serper-${index + 1}`,
    source: 'serper:lovdata.no',
    title: item.title ?? 'Uten tittel',
    snippet: item.snippet ?? null,
    date: item.date ?? null,
    link: item.link ?? null
  }));
}
```

#### 3.2 Update Agent System Prompt
**File:** `backend/src/agents/openAIAgent.ts`

Update `SYSTEM_PROMPT` to include function calling instructions for both skills and HTML link requirements:

```typescript
const SYSTEM_PROMPT = `Du er en juridisk assistent som bruker dokumenter fra Lovdatas offentlige data.
Svar alltid på norsk med et presist, nøkternt språk.

Funksjonsbruk:
Du har tilgang til to søkefunksjoner:

1. search_lovdata_legal_documents:
   - Bruk denne for å finne lover, forskrifter, vedtak og andre juridiske dokumenter.
   - Ekstraher relevante søkeord fra brukerens spørsmål for query-parameteret.
   - Hvis brukerens spørsmål ikke spesifiserer dokumenttype, la lawType være undefined - funksjonen vil da automatisk søke i prioritert rekkefølge.
   - Dokumenttype-prioritering (hvis ikke spesifisert av brukeren): 1. Lov, 2. Forskrift, 3. Vedtak, 4. Instruks, 5. Reglement, 6. Vedlegg.
   - Hvis første søk gir få resultater, kan du prøve en annen dokumenttype eller søke uten spesifikk type.

2. search_lovdata_legal_practice:
   - Bruk denne for å finne utdypende informasjon om hvordan lover og forskrifter brukes i praksis.
   - Søker i rettsavgjørelser, Lovtidend, Trygderetten, Husleietvistutvalget og lignende kilder.
   - Bruk denne når du trenger:
     * Eksempler på praktisk anvendelse av lover
     * Rettsavgjørelser som illustrerer tolkning av lovtekster
     * Kontekst om hvordan rettsregler brukes i rettssystemet
   - Bruk gjerne begge funksjoner i kombinasjon: først search_lovdata_legal_documents for lovtekster, deretter search_lovdata_legal_practice for praktiske eksempler.

Retningslinjer:
- Du blir gitt et spørsmål og kan søke etter relevante dokumenter ved å bruke funksjoner.
- Vurder når det er lurt å bruke begge funksjoner for å gi et komplett svar.
- Evaluer informasjonen fra søkeresultatene og bruk det til å svare på spørsmålet.
- Lag en oppsummering som tar med hovedpunkter og peker på den mest relevante informasjonen med forklaring.
- Gi sitatreferanser ved å bruke evidenceId for å referere til kildene.
- **VIKTIG**: Inkluder HTML-lenker til dokumentene i svaret ditt. Hver kilde i evidence-listen har en "link"-felt med direkte lenke til dokumentet.
- **Bruk HTML-format for lenker**: <a href="link">tittel</a> når du refererer til dokumenter i answer-feltet.
- Alle dokumenter som brukes i svaret skal ha lenker inkludert.
- Hvis du mangler tilstrekkelig grunnlag, si det høflig og foreslå videre søk.
- Returner alltid JSON på formatet {"answer": "...", "citations": [{"evidenceId": "lovdata-1", "quote": "..."}]}.
- Merk: Labels (nummerering) vil bli satt automatisk basert på rekkefølgen i listen.`;
```

**Key changes:**
- Instructions on when to use each search function
- Guidance on using both functions together
- Law type priority explanation
- Guidance on extracting search parameters
- Note that prioritized search happens automatically if lawType is not specified
- Instruction to try different searches if needed
- **Explicit instructions to include HTML links in answers**
- **Requirement to include links for all documents used**

### Phase 4: Restrict Serper URL Patterns and Integrate as Agent Function

#### 4.1 Update Serper Client to Support Restricted URL Patterns
**File:** `backend/src/services/serperClient.ts`

**Add new option** to restrict URL patterns for agent searches:

```typescript
// Update SerperSearchOptions to include restrictedPatterns
export type SerperSearchOptions = {
  num?: number;
  gl?: string;
  hl?: string;
  site?: string;
  targetDocuments?: boolean;
  restrictedPatterns?: string[]; // NEW: Specific URL patterns to search (overrides targetDocuments patterns)
};

// Constants for restricted patterns (agent use only)
export const AGENT_RESTRICTED_PATTERNS = [
  '/avgjørelser/',
  '/lovtidend/',
  '/husleietvistutvalget/',
  '/trygderetten/',
  '/sph2025/'
];

// Update search method to use restricted patterns if provided
async search(query: string, options: SerperSearchOptions = {}): Promise<SerperResponse> {
  // ... existing code ...
  
  if (options.site) {
    const normalizedSite = options.site.replace(/^https?:\/\//, '').replace(/\/$/, '');
    
    // Use restricted patterns if provided (for agent calls), otherwise use default targetDocuments logic
    if (options.restrictedPatterns && options.restrictedPatterns.length > 0) {
      const patternQueries = options.restrictedPatterns.map(pattern => `inurl:${pattern}`).join(' OR ');
      siteQuery = `site:${normalizedSite} (${patternQueries}) `;
    } else if (options.targetDocuments) {
      // ... existing targetDocuments logic with all patterns ...
      // (Keep existing code for backward compatibility)
    } else {
      siteQuery = `site:${normalizedSite} `;
    }
  }
  
  // ... rest of method ...
}
```

**Note:** When `restrictedPatterns` is provided, it completely replaces the default `targetDocuments` patterns. This allows agent calls to use only the 5 specified patterns, while other use cases can continue using the broader `targetDocuments` patterns.

#### 4.2 Update Lovdata-Serper Skill to Use Restricted Patterns
**File:** `backend/src/skills/lovdata-serper/index.ts`

**Update execute function** to use restricted URL patterns for agent searches:

```typescript
import { AGENT_RESTRICTED_PATTERNS } from '../../services/serperClient.js';

export async function execute(io: SkillIO, ctx: SkillContext): Promise<SkillOutput> {
  // ... existing code ...
  
  // Check if this is an agent call (from context)
  const isAgentCall = (ctx as any).agentCall === true;
  
  logger.info({ 
    query: input.query, 
    site, 
    targetDocuments: shouldTargetDocuments,
    isAgentCall 
  }, 'lovdata-serper: executing search');
  
  if (shouldTargetDocuments || isAgentCall) {
    // For agent calls, use restricted patterns; otherwise use default document search
    const searchOptions: SerperSearchOptions = {
      num: input.num,
      gl: input.gl,
      hl: input.hl,
      site: isAgentCall ? 'lovdata.no' : site, // Always lovdata.no for agent calls
    };
    
    if (isAgentCall) {
      // Agent calls: use restricted patterns only
      searchOptions.restrictedPatterns = AGENT_RESTRICTED_PATTERNS;
      searchOptions.targetDocuments = false; // Don't use default patterns
    } else {
      // Non-agent calls: use default targetDocuments behavior
      searchOptions.targetDocuments = shouldTargetDocuments;
    }
    
    response = await client.searchDocuments(input.query, searchOptions);
    // ... rest of code ...
  }
  
  // ... existing code ...
}
```

**Note:** The context should include an `agentCall: true` flag when called from the agent function execution handler in assistant.ts.

#### 4.3 Remove Serper Fallback from Lovdata-API Skill
**File:** `backend/src/skills/lovdata-api/index.ts`

**Remove serper fallback logic** (lines 104-124) since agent will call serper directly:

```typescript
// REMOVE this entire block:
// if (services.serper) {
//   const shouldFetchFallback = ...
//   if (shouldFetchFallback) {
//     const fallback = await services.serper.searchDocuments(...);
//     fallbackInfo = { ... };
//   }
// }

// Remove fallbackInfo variable and return fallback field
return {
  result: {
    query: command.query,
    hits,
    searchedFiles,
    page,
    pageSize,
    totalHits,
    totalPages
    // REMOVE: fallback: fallbackInfo
  },
  meta: {
    // ... existing meta fields
    // REMOVE: fallbackProvider: fallbackInfo?.provider
  }
};
```

#### 4.3 Disable Reranking for Agent Searches
**File:** `backend/src/services/lovdataSearch.ts` and `backend/src/services/assistant.ts`

When agent calls the search function:
- **Disable reranking** by not passing `enableReranking: true`
- Remove reranking from search flow for agent-directed searches

**In assistant.ts (when executing function calls):**
```typescript
const skillResult = await searchLovdataPublicData({
  store: archiveStore,
  query: searchParams.query,
  page: searchParams.page || 1,
  pageSize: searchParams.pageSize || 10,
  enableReranking: false, // Explicitly disable for agent searches
  filters: {
    lawType: searchParams.lawType,
    year: searchParams.year,
    ministry: searchParams.ministry
  }
});
```

#### 4.4 Update Evidence Building (Include Both Lovdata-API and Serper Results)
**File:** `backend/src/services/assistant.ts`

**Update `buildEvidence` function** to handle both lovdata-api and serper results:

```typescript
function buildEvidence(
  lovdataResult: LovdataSkillSearchResult,
  serperResults?: Array<{ title: string | null; link: string | null; snippet: string | null; date: string | null }>
): AgentEvidence[] {
  const evidence: AgentEvidence[] = [];

  // Add lovdata-api hits
  (lovdataResult.hits ?? []).forEach((hit, index) => {
    evidence.push({
      id: `lovdata-${index + 1}`,
      source: 'lovdata',
      title: hit.title ?? hit.filename ?? 'Uten tittel',
      snippet: hit.snippet,
      date: hit.date ?? null,
      link: buildXmlViewerUrl(hit.filename, hit.member),
      metadata: {
        filename: hit.filename,
        member: hit.member
      }
    });
  });

  // Add serper results (from agent function calls)
  if (serperResults && serperResults.length > 0) {
    serperResults.forEach((item, index) => {
      evidence.push({
        id: `serper-${index + 1}`,
        source: 'serper:lovdata.no',
        title: item.title ?? 'Uten tittel',
        snippet: item.snippet ?? null,
        date: item.date ?? null,
        link: item.link ?? null // Already HTML links from serper
      });
    });
  }

  return evidence;
}
```

### Phase 5: Ensure Agent Provides HTML Links in Citations

#### 5.1 Update Agent System Prompt for HTML Links
**File:** `backend/src/agents/openAIAgent.ts`

Update system prompt to instruct agent to include HTML links in citations:

```typescript
const SYSTEM_PROMPT = `...existing prompt...

- Gi sitatreferanser i svaret ved å bruke evidenceId for å referere til kildene.
- For hver kilde du refererer til, inkluder HTML-lenken fra evidence-listen i sitatet når det er relevant.
- Alle dokumenter har lenker (link-feltet) som kan brukes i HTML-format: <a href="link">tittel</a>.
- Returner alltid JSON på formatet {"answer": "...", "citations": [{"evidenceId": "lovdata-1", "quote": "..."}]}.
- I answer-feltet, kan du inkludere lenker direkte i HTML-format for bedre brukeropplevelse.
...`;
```

#### 5.2 Ensure Links Are Available in Evidence
**File:** `backend/src/services/assistant.ts`

The `buildEvidence` function already includes links via `buildXmlViewerUrl()`. Verify that:
- All evidence items have `link` field populated
- Links point to the document viewer endpoint
- Links are HTML-ready (already handled by `updateLinksForHtmlContent`)

### Phase 6: Update Skill Metadata

#### 6.1 Update Skill Description
**File:** `backend/src/skills/lovdata-api/skill.json`

Update description to reflect agent-directed usage:
```json
{
  "description": "Søk gjennom Lovdata juridiske dokumenter. Brukes av agenten for å finne relevante lover, forskrifter og andre juridiske dokumenter basert på brukerens spørsmål. Støtter prioritert søk etter dokumenttype."
}
```

## Implementation Details

### Function Calling Flow

1. **Agent receives question** with function definitions available
2. **Agent analyzes question** and decides to call `search_lovdata_legal_documents`
3. **Agent extracts parameters**:
   - Query terms from question
   - Law type (if mentioned, or defaults to "Lov")
   - Year (if mentioned)
   - Ministry (if mentioned)
4. **Skill executes** with prioritized search logic
5. **Results returned** to agent
6. **Agent evaluates results**:
   - If sufficient results → generate answer
   - If insufficient results → try next law type in priority
7. **Agent generates final answer** with citations

### Backward Compatibility

- Keep existing skill execution path for non-agent use cases
- Add new function calling path that can coexist
- Use feature flag or configuration to switch between modes

### Error Handling

- If function call fails, return error to agent
- Agent can handle errors and try alternative searches
- Log all function calls for debugging

## Testing Strategy

1. **Unit tests** for prioritized search logic
2. **Integration tests** for function calling flow
3. **E2E tests** with real questions:
   - Question mentioning specific law type
   - Question without law type (should default to Lov)
   - Question that needs multiple searches
   - Question with year/ministry filters

## Migration Path

1. Implement function calling infrastructure (Phase 1)
2. Add prioritized search to skill (Phase 2)
3. Integrate with assistant (Phase 3)
4. Test thoroughly
5. Deploy with feature flag
6. Monitor and adjust
7. Remove old hardcoded path once stable

## Files to Modify

### New Files
- `backend/src/skills/lovdata-api/functionSchema.ts` - Function schema definition

### Modified Files
- `backend/src/agents/types.ts` - Add function calling types
- `backend/src/agents/openAIAgent.ts` - Add function calling support + HTML link instructions for both skills
- `backend/src/skills/lovdata-api/index.ts` - Add prioritized search, remove serper fallback
- `backend/src/skills/lovdata-api/functionSchema.ts` - Function schema for lovdata-api skill (NEW)
- `backend/src/skills/lovdata-serper/functionSchema.ts` - Function schema for serper skill (NEW)
- `backend/src/skills/lovdata-serper/index.ts` - Update to use restricted URL patterns for agent calls
- `backend/src/services/serperClient.ts` - Add support for restricted URL patterns
- `backend/src/services/assistant.ts` - Integrate function calling for both skills, handle serper function calls
- `backend/src/services/lovdataSearch.ts` - Disable reranking for agent searches (or update calls)
- `backend/src/skills/lovdata-api/skill.json` - Update description

## Success Criteria

1. ✅ Agent can call lovdata-api skill directly via function calling
2. ✅ Agent intelligently extracts search parameters from user questions
3. ✅ Law type priority is followed: Lov → Forskrift → Vedtak → Instruks → Reglement → Vedlegg
4. ✅ Agent can perform multiple searches if initial search is insufficient
5. ✅ Backward compatibility maintained for existing code paths (optional via feature flag)
6. ✅ Performance is acceptable (no significant degradation)
7. ✅ Hardcoded search execution is removed from assistant.ts
8. ✅ **lovdata-serper skill is available as agent function with restricted URL patterns**
9. ✅ **Cohere reranking is disabled for agent-directed searches**
10. ✅ **Agent provides citations with HTML links to all relevant documents**
11. ✅ **Evidence contains both lovdata-api and lovdata-serper results**
12. ✅ **Serper searches restricted to: /avgjørelser/, /lovtidend/, /husleietvistutvalget/, /trygderetten/, /sph2025/**

## Implementation Order (Recommended)

1. **Start with Phase 4** - Update serper client and skill for restricted URL patterns (can be tested independently)
2. **Then Phase 2** - Add prioritized search to lovdata-api skill (can be tested independently)
3. **Then Phase 1** - Add function calling infrastructure (both function schemas)
4. **Then Phase 3** - Integrate everything and update assistant flow (handle both function calls)
5. **Finally Phase 5** - Ensure HTML links in citations

This allows incremental development and testing, with serper pattern restrictions happening early.

## Key Design Decisions

### Decision 1: Where to implement prioritization?
**Chosen:** Skill-level prioritization (Option A in Phase 2.1)
- More efficient (single search call)
- Agent doesn't need to handle multiple calls
- Simpler agent logic

### Decision 2: Feature flag or breaking change?
**Recommendation:** Use feature flag initially
- Allows gradual rollout
- Easier to revert if issues
- Can A/B test both approaches

### Decision 3: How many agent iterations?
**Chosen:** Max 5 iterations
- Prevents infinite loops
- Allows agent to try multiple searches
- Reasonable timeout limit

## Notes

- This change requires OpenAI models that support function calling (gpt-4, gpt-4-turbo, gpt-4o, gpt-3.5-turbo)
- Function calling adds some latency due to multiple round trips
- Consider caching search results if agent makes similar queries
- Monitor function call costs (each function call counts as tokens)
- **Serper integration removed**: The lovdata-serper skill is no longer used by the agent, simplifying the flow
- **Reranking disabled**: Cohere reranking is not used for agent searches, relying on the hybrid search (FTS + vector) quality
- **HTML links in answers**: The agent must include clickable HTML links to documents in its answers for better UX

## Summary of Changes

### Modified in Agent Flow:
1. ✅ **lovdata-serper skill** - Now available as agent function (not hardcoded execution)
2. ✅ **Serper URL patterns** - Restricted to specific patterns for agent searches
3. ✅ **Cohere reranking** - Disabled for agent-directed searches
4. ✅ **Serper fallback from lovdata-api** - Removed (agent calls serper directly when needed)

### Added/Enhanced:
1. ✅ **Function calling** - Agent directly controls both search functions
2. ✅ **Dual search strategy** - Agent can use both lovdata-api and serper for comprehensive answers
3. ✅ **Prioritized law type search** - Lov → Forskrift → Vedtak → Instruks → Reglement → Vedlegg
4. ✅ **HTML links in citations** - Agent includes clickable links to documents
5. ✅ **Intelligent parameter extraction** - Agent extracts query, lawType, year, ministry from questions
6. ✅ **Restricted serper patterns** - Only searches in: /avgjørelser/, /lovtidend/, /husleietvistutvalget/, /trygderetten/, /sph2025/

