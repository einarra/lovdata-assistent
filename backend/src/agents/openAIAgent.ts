import OpenAI from 'openai';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import type { Agent, AgentEvidence, AgentInput, AgentOutput, AgentOutputCitation } from './types.js';

const SYSTEM_PROMPT_BASE = `Du er en juridisk assistent som bruker dokumenter fra Lovdatas offentlige data.
Svar alltid på norsk med et presist, nøkternt språk.`;

const SYSTEM_PROMPT_WITH_FUNCTIONS = `${SYSTEM_PROMPT_BASE}

KRITISK VIKTIG - SØK ALLTID FØRST:
- Du MÅ alltid bruke søkefunksjonene før du svarer på spørsmål
- IKKE svar basert kun på din egen kunnskap - du MÅ søke etter relevante dokumenter
- For hvert spørsmål, start med å kalle search_lovdata_legal_documents eller search_lovdata_legal_practice
- Kun etter å ha fått søkeresultater kan du svare på spørsmålet
- Hvis du svarer uten å søke først, vil svaret ditt ikke ha noen kilder og vil være ufullstendig

Funksjonsbruk:
Du har tilgang til to søkefunksjoner:

1. search_lovdata_legal_documents:
   - Bruk denne for å finne lover, forskrifter, vedtak og andre juridiske dokumenter fra offentlige data.
   - Ekstraher relevante søkeord fra brukerens spørsmål for query-parameteret.
   - Hvis brukerens spørsmål ikke spesifiserer dokumenttype, la lawType være undefined - funksjonen vil da automatisk søke i prioritert rekkefølge.
   - Dokumenttype-prioritering (hvis ikke spesifisert av brukeren): 1. Lov, 2. Forskrift, 3. Vedtak, 4. Instruks, 5. Reglement, 6. Vedlegg.
   - VIKTIG: For søk etter lover og forskrifter, begrens søket til dokumenter fra de siste 5 årene (fra 2021 og nyere) med mindre brukeren eksplisitt ber om eldre dokumenter eller spesifiserer et annet år.
   - Bruk year-parameteret for å begrense søket: sett year til minst 2021 (eller nyere hvis brukeren ber om det) når du søker etter lover og forskrifter.
   - Hvis brukeren ber om eldre dokumenter eller spesifiserer et år, bruk det året i stedet.
   - Hvis første søk gir få resultater, kan du prøve en annen dokumenttype eller søke uten spesifikk type.

2. search_lovdata_legal_practice:
   - Bruk denne for å søke direkte på lovdata.no og finne lover, sentrale forskrifter, rettsavgjørelser og kunngjøringer.
   - VIKTIG: Denne funksjonen gir deg direkte lenker til dokumenter på lovdata.no som inkluderes i evidence-listen.
   - SØKEMETODE: Funksjonen søker på hele lovdata.no basert på søkeordene dine. Den finner relevante dokumenter (artikler, rettsavgjørelser, kunngjøringer) .
   - PRIORITER RETTSAVGJØRELSER: Når brukeren spør om hvordan en lov eller forskrift anvendes, eller om praktiske eksempler, skal du prioritere å finne rettsavgjørelser ved å:
     * Bruke relevante søkeord som kombinerer lovnavn/forskrift med juridiske termer fra spørsmålet
     * Inkludere termer som "avgjørelse", "dom", "praksis" eller lignende for å finne rettsavgjørelser
     * Fokusere på å finne rettsavgjørelser som illustrerer tolkning og anvendelse
     * Rettsavgjørelser gir ofte bedre svar på "hvordan" og "i praksis" enn bare lovtekster
   - Bruk denne når du trenger:
     * Rettsavgjørelser og dommer (PRIORITERT) - viktigste kilden for praktisk anvendelse
     * Lover publisert på lovdata.no
     * Sentrale forskrifter publisert på lovdata.no
     * Kunngjøringer i Lovtidend
     * Eksempler på praktisk anvendelse av lover
     * Kontekst om hvordan rettsregler brukes i praksis
   - VIKTIG: For de fleste spørsmål om lover, bør du bruke BEGGE funksjoner:
     * Først: search_lovdata_legal_documents for å finne relevante lover og forskrifter.
     * Deretter: search_lovdata_legal_practice for å finne artikler, avgjørelser og praktiske eksempler fra lovdata.no
   - Dette gir et mer komplett svar som både forklarer loven og viser hvordan den brukes i praksis.
   - Alle lenker fra denne funksjonen peker direkte til dokumenter på lovdata.no og inkluderes automatisk i evidence-listen.
   - SØK PÅ NYTT: Hvis første søk ikke gir relevante resultater, eller hvis brukeren ber om mer informasjon eller spesifikke eksempler, kan du søke på nytt med forbedrede søkeord. Du kan også søke flere ganger med ulike vinklinger eller mer spesifikke søkeord for å finne bedre resultater.

Retningslinjer:
- Du blir gitt et spørsmål og kan søke etter relevante dokumenter ved å bruke funksjoner.
- Vurder når det er lurt å bruke begge funksjoner for å gi et komplett svar.
- SØK PÅ NYTT VED BEHOV: Hvis brukeren ber om mer informasjon, spesifikke eksempler, eller gir tilleggsinformasjon, kan du søke på nytt med forbedrede søkeord. Du kan også søke flere ganger med ulike vinklinger for å finne bedre resultater.
- KRITISK VIKTIG: Når du får søkeresultater fra search_lovdata_legal_documents, må du evaluere dem FØR du går videre:
  * Du får alle søkeresultater med titler og utdrag i funksjonsresultatet
  * Sjekk nøye om hvert resultat faktisk svarer på brukerens spørsmål
  * Hvis resultatene er irrelevante, ufullstendige eller ikke gir nok informasjon:
    - IKKE bruk disse resultatene i svaret
    - Forbedre søkeordene og søk på nytt med mer spesifikke termer
    - Prøv annen dokumenttype (lawType) hvis nødvendig
    - Juster år-filteret hvis nødvendig
    - Du kan søke flere ganger for å finne bedre resultater
  * Kun når resultatene er relevante og gir nok informasjon, kan du gå videre og svare
  * Hvis du ikke søker på nytt etter å ha fått resultater, antas det at resultatene er relevante
- Evaluer informasjonen fra søkeresultatene og bruk det til å svare på spørsmålet.
- Lag en oppsummering som tar med hovedpunkter og peker på den mest relevante informasjonen med forklaring.
- Gi sitatreferanser ved å bruke evidenceId for å referere til kildene.
- VIKTIG: Inkluder HTML-lenker til dokumentene i svaret ditt. Hver kilde i evidence-listen har en "link"-felt med direkte lenke til dokumentet.
- Bruk HTML-format for lenker: <a href="link">tittel</a> når du refererer til dokumenter i answer-feltet.
- Alle dokumenter som brukes i svaret skal ha lenker inkludert.
- VIKTIG: Når du bruker search_lovdata_legal_practice, får du direkte lenker til dokumenter på lovdata.no. Disse lenkene inkluderes automatisk i evidence-listen og skal brukes i svaret ditt.
- Hvis du mangler tilstrekkelig grunnlag, si det høflig og foreslå videre søk.
- Når du har nok informasjon, returner JSON på formatet {"answer": "...", "citations": [{"evidenceId": "lovdata-1", "quote": "..."}]}.
- Hvis du trenger å søke, bruk funksjonene tilgjengelig for deg.
- Merk: Labels (nummerering) vil bli satt automatisk basert på rekkefølgen i listen.`;

const SYSTEM_PROMPT_WITHOUT_FUNCTIONS = `${SYSTEM_PROMPT_BASE}

Retningslinjer:
- Du blir gitt et spørsmål og en liste over kilder med relevant informasjon.
- Evaluer all informasjonen du nå har, som ligger i evidenslisten, og bruk det til å svare på spørsmålet.
- Lag en oppsummering som tar med hovedpunkter og peker på den den mest relevante informasjonen i evidentslisten med en forklaring av hvorfor du har valgt den informasjonen. 
- Oppsummer informasjon som finnes i evidenslisten, og inkluder det i svaret på spørsmålet.
- Hvis kildene er motstridende, gjør det eksplisitt og vær forsiktig i konklusjonene.
- Gi sitatreferanser i svaret ved å bruke evidenceId for å referere til kildene.
- Hvis du mangler tilstrekkelig grunnlag, si det høflig og foreslå videre søk.
- Returner alltid JSON på formatet {"answer": "...", "citations": [{"evidenceId": "lovdata-1", "quote": "..."}]}.
- Merk: Labels (nummerering) vil bli satt automatisk basert på rekkefølgen i listen - du trenger ikke å inkludere "label" feltet.
`;

export type OpenAIAgentOptions = {
  model?: string;
  temperature?: number;
};

export class OpenAIAgent implements Agent {
  private client: OpenAI;
  private model: string;
  private temperature: number;

  constructor(options: OpenAIAgentOptions = {}) {
    if (!env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    // Configure OpenAI client with timeout to prevent hanging
    // Add timeout at the client level as a fallback
    this.client = new OpenAI({ 
      apiKey: env.OPENAI_API_KEY,
      // Don't set client-level timeout - we handle timeouts with Promise.race
      // Setting a client timeout can interfere with our custom timeout logic
      maxRetries: 0 // Disable retries to avoid delays
    });
    this.model = options.model ?? env.OPENAI_MODEL;
    this.temperature = options.temperature ?? env.OPENAI_TEMPERATURE;
  }

  async generate(input: AgentInput): Promise<AgentOutput> {
    // Input validation
    if (!input.question || typeof input.question !== 'string') {
      throw new Error('Question is required and must be a string');
    }
    
    const trimmedQuestion = input.question.trim();
    if (trimmedQuestion.length === 0) {
      throw new Error('Question cannot be empty');
    }
    
    if (trimmedQuestion.length > CONFIG.MAX_QUESTION_LENGTH) {
      logger.warn({ 
        questionLength: trimmedQuestion.length,
        maxLength: CONFIG.MAX_QUESTION_LENGTH 
      }, 'Question exceeds maximum length, truncating');
    }
    
    const question = trimmedQuestion.substring(0, CONFIG.MAX_QUESTION_LENGTH);
    
    // Validate evidence
    if (input.evidence && input.evidence.length > CONFIG.MAX_EVIDENCE_COUNT) {
      logger.warn({ 
        evidenceCount: input.evidence.length,
        maxCount: CONFIG.MAX_EVIDENCE_COUNT 
      }, 'Evidence array exceeds maximum count, truncating');
    }
    
    const evidence = input.evidence?.slice(0, CONFIG.MAX_EVIDENCE_COUNT) ?? [];
    
    // Determine which system prompt to use based on whether functions are provided
    const hasFunctions = input.functions && input.functions.length > 0;
    const systemPrompt = hasFunctions ? SYSTEM_PROMPT_WITH_FUNCTIONS : SYSTEM_PROMPT_WITHOUT_FUNCTIONS;
    
    // Build prompt - if we have function results, include them
    let prompt = buildUserPrompt(question, evidence);
    
    // If we have function results from previous calls, include them in the prompt
    if (input.functionResults && input.functionResults.length > 0) {
      const functionResultsText = input.functionResults.map((fr, idx) => {
        const resultStr = typeof fr.result === 'string' 
          ? fr.result 
          : JSON.stringify(fr.result, null, 2);
        return `Resultat fra ${fr.name} (kall ${idx + 1}):\n${resultStr}`;
      }).join('\n\n');
      prompt = `${prompt}\n\nTidligere søkeresultater:\n${functionResultsText}`;
    }
    
    // Validate model name - "gpt-5" is not a valid OpenAI model and may cause hangs
    const knownValidModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'];
    if (!knownValidModels.includes(this.model)) {
      logger.warn({ 
        model: this.model,
        knownValidModels 
      }, 'OpenAIAgent.generate: model name not in known valid list - this may cause the API to hang or fail. Common valid models: gpt-4o-mini, gpt-4o, gpt-4-turbo');
    }
    
    logger.info({
      hasFunctions,
      functionCount: input.functions?.length ?? 0,
      functionResultsCount: input.functionResults?.length ?? 0
    }, 'OpenAIAgent.generate: function calling info');
    
    // Calculate adaptive timeout based on prompt size
    // Larger prompts take longer to process
    // With Vercel Pro 60s limit, we have plenty of headroom (~57s remaining after setup)
    // Use a generous fixed timeout since we have headroom - simpler and more reliable
    // Base timeout: configurable via environment variable (default 30s)
    // Add 2 seconds per 10KB of prompt (up to max timeout to leave 5s buffer)
    const promptSizeKB = prompt.length / 1024;
    const baseTimeout = env.OPENAI_AGENT_BASE_TIMEOUT_MS;
    const maxTimeout = env.OPENAI_AGENT_MAX_TIMEOUT_MS;
    const additionalTimeout = Math.min(promptSizeKB * 200, maxTimeout - baseTimeout); // 2s per 10KB
    const timeoutMs = Math.min(baseTimeout + additionalTimeout, maxTimeout);
    
    logger.info({ 
      question: question.substring(0, 100),
      evidenceCount: evidence.length,
      model: this.model,
      promptLength: prompt.length,
      promptSizeKB: Math.round(promptSizeKB * 10) / 10,
      timeoutMs
    }, 'OpenAIAgent.generate: starting API call');
    
    const startTime = Date.now();
    const controller = new AbortController();

    // Debug mode: Add progress checks only if DEBUG_OPENAI_AGENT is enabled
    let progressCheckInterval: NodeJS.Timeout | null = null;
    const safetyChecks: NodeJS.Timeout[] = [];
    
    if (DEBUG_MODE) {
      logger.debug('OpenAIAgent: Setting up progress checks (debug mode enabled)');
      progressCheckInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        logger.debug({ elapsedMs: elapsed, timeoutMs }, 'OpenAIAgent: Still waiting for OpenAI response');
      }, 1000);
      
      // Add safety checks at intervals (only in debug mode)
      [1000, 2000, 3000, 4000].forEach(delay => {
        const check = setTimeout(() => {
          const elapsed = Date.now() - startTime;
          logger.debug({ elapsedMs: elapsed, timeoutMs, remainingMs: timeoutMs - elapsed }, 'OpenAIAgent: Safety check');
        }, delay);
        safetyChecks.push(check);
      });
    }

    let response;
    try {
      if (DEBUG_MODE) {
        logger.debug({ timeoutMs }, 'OpenAIAgent: Starting API call');
        logger.debug({ model: this.model, promptLength: prompt.length, evidenceCount: evidence.length }, 'OpenAIAgent: API call parameters');
      }
      
      logger.info({ timeoutMs }, 'OpenAIAgent.generate: calling OpenAI API');
      
      // Build messages array - include function results as assistant messages
      const messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content?: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }> = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ];
      
      // Note: We don't include tool messages here because OpenAI requires them to follow
      // an assistant message with tool_calls, and we don't store message history between iterations.
      // Instead, we include function results in the user prompt (already done above in prompt building).
      
      // Build tools array if functions are provided
      const tools = hasFunctions ? input.functions!.map(fn => ({
        type: 'function' as const,
        function: {
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters as Record<string, unknown>
        }
      })) as OpenAI.Chat.Completions.ChatCompletionTool[] : undefined;
      
      const requestParams: Parameters<typeof this.client.chat.completions.create>[0] = {
        model: this.model,
        temperature: this.temperature,
        messages: messages as any,
        max_tokens: hasFunctions ? 2000 : 1000 // Allow more tokens when function calling
      };
      
      // Only set response_format and tools when appropriate
      if (!hasFunctions) {
        requestParams.response_format = { type: 'json_object' };
      } else {
        requestParams.tools = tools;
        requestParams.tool_choice = 'auto'; // Let the model decide when to use tools
      }
      
      const apiCallPromise = this.client.chat.completions.create(
        requestParams,
        {
          signal: controller.signal
        }
      ).catch(error => {
        // Log immediately if the promise rejects
        const elapsed = Date.now() - startTime;
        if (DEBUG_MODE) {
          logger.debug({ elapsedMs: elapsed, error: error instanceof Error ? error.message : String(error) }, 'OpenAIAgent: API call promise rejected immediately');
        }
        throw error;
      });
      
      // Create a timeout promise that will reject if the API call takes too long
      // Use a separate timeout ID so we can log when it's set up
      // Create the timeout OUTSIDE the Promise constructor to ensure it's set immediately
      let timeoutId: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          const elapsed = Date.now() - startTime;
          logger.error({ elapsedMs: elapsed, timeoutMs }, 'OpenAIAgent.generate: timeout triggered');
          controller.abort();
          reject(new Error(`OpenAI API call timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        
        if (DEBUG_MODE) {
          logger.debug({ timeoutMs, timeoutId: timeoutId ? 'set' : 'not set' }, 'OpenAIAgent: Timeout promise created');
        }
      });
      
      // Use Promise.race to ensure timeout always triggers
      const racePromise = Promise.race([
        apiCallPromise.then(result => {
          const elapsed = Date.now() - startTime;
          if (DEBUG_MODE) {
            logger.debug({ elapsedMs: elapsed }, 'OpenAIAgent: API call promise resolved first');
          }
          // Clear timeout since we succeeded
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          return result;
        }),
        timeoutPromise.catch(error => {
          const elapsed = Date.now() - startTime;
          if (DEBUG_MODE) {
            logger.debug({ elapsedMs: elapsed }, 'OpenAIAgent: Timeout promise rejected first');
          }
          throw error;
        })
      ]);
      
      // Wrap the await in a try-catch with proper cleanup
      try {
        response = await racePromise;
      } catch (raceError) {
        // Clear timeout on error too
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        throw raceError;
      } finally {
        // Clear all timeouts and intervals in all exit paths
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (progressCheckInterval) {
          clearInterval(progressCheckInterval);
          progressCheckInterval = null;
        }
        safetyChecks.forEach(check => {
          clearTimeout(check);
        });
        safetyChecks.length = 0; // Clear array
        
        if (DEBUG_MODE) {
          logger.debug('OpenAIAgent: Progress checks cleared');
        }
      }
      
      const elapsed = Date.now() - startTime;
      if (DEBUG_MODE) {
        logger.debug({ elapsedMs: elapsed }, 'OpenAIAgent: API call completed');
      }
      
      // Type guard for ChatCompletion (not Stream)
      if (!response || 'choices' in response === false) {
        throw new Error('Unexpected response type from OpenAI API');
      }
      
      logger.info({ 
        hasResponse: !!response,
        choicesCount: response.choices?.length ?? 0,
        elapsedMs: elapsed
      }, 'OpenAIAgent.generate: OpenAI API call completed');
    } catch (error) {
      // Clear all timeouts and intervals in error path
      if (progressCheckInterval) {
        clearInterval(progressCheckInterval);
        progressCheckInterval = null;
      }
      safetyChecks.forEach(check => {
        clearTimeout(check);
      });
      safetyChecks.length = 0;
      
      const elapsed = Date.now() - startTime;
      if (DEBUG_MODE) {
        logger.debug({ elapsedMs: elapsed, error: error instanceof Error ? error.message : String(error) }, 'OpenAIAgent: Catch block entered');
      }
      
      if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('timed out'))) {
        logger.error({ timeoutMs, elapsedMs: elapsed }, 'OpenAIAgent.generate: API call timed out');
        throw new Error(`OpenAI API call timed out after ${timeoutMs}ms`);
      }
      logger.error({ 
        err: error,
        elapsedMs: elapsed,
        stack: error instanceof Error ? error.stack : undefined
      }, 'OpenAIAgent.generate: API call failed');
      throw error;
    }

    // Type guard: response should be ChatCompletion at this point
    if (!response || !('choices' in response)) {
      throw new Error('Unexpected response type from OpenAI API');
    }
    
    const message = response.choices[0]?.message;
    const toolCalls = message?.tool_calls;
    const raw = message?.content ?? '';
    
    // Check if the model wants to call functions
    if (toolCalls && toolCalls.length > 0) {
      if (DEBUG_MODE) {
        logger.debug({ toolCallsCount: toolCalls.length }, 'OpenAIAgent: Model requested function calls');
      }
      logger.info({ toolCallsCount: toolCalls.length }, 'OpenAIAgent.generate: model requested function calls');
      
      // Extract function calls with tool_call_id
      const functionCalls: AgentOutput['functionCalls'] = toolCalls
        .filter((tc: any) => tc.type === 'function')
        .map((tc: any) => ({
          name: tc.function.name,
          arguments: tc.function.arguments,
          toolCallId: tc.id // Store the actual tool_call_id from OpenAI (must be <= 40 chars)
        }));
      
      return {
        functionCalls,
        model: this.model
      };
    }
    
    // No function calls - parse the response as usual
    if (DEBUG_MODE) {
      logger.debug({ rawLength: raw.length }, 'OpenAIAgent: Response received');
    }
    logger.info({ rawLength: raw.length }, 'OpenAIAgent.generate: parsing response');
    
    let parsed;
    try {
      parsed = parseAgentJson(raw);
      if (DEBUG_MODE) {
        logger.debug({ hasAnswer: !!parsed.answer }, 'OpenAIAgent: Response parsed successfully');
      }
      logger.debug({ hasAnswer: !!parsed.answer }, 'OpenAIAgent.generate: JSON parsed');
    } catch (parseError) {
      if (DEBUG_MODE) {
        logger.debug({ error: parseError instanceof Error ? parseError.message : String(parseError) }, 'OpenAIAgent: Parse error');
      }
      logger.error({ err: parseError, raw }, 'OpenAIAgent.generate: failed to parse JSON response');
      return {
        answer: raw.trim() || 'Jeg klarte ikke å formulere et svar basert på kildene.',
        citations: [],
        model: this.model
      };
    }
    
    if (!parsed.answer) {
      logger.warn({ raw }, 'OpenAI agent returned empty answer; falling back to raw text');
      return {
        answer: raw.trim() || 'Jeg klarte ikke å formulere et svar basert på kildene.',
        citations: [],
        model: this.model
      };
    }

    const citations: AgentOutput['citations'] = (() => {
      if (!Array.isArray(parsed.citations)) {
        return [];
      }
      const normalized = parsed.citations
        .map((entry: unknown) => normaliseCitation(entry))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
      return normalized;
    })();

    if (DEBUG_MODE) {
      logger.debug({ 
        answerLength: parsed.answer.trim().length,
        citationsCount: citations.length
      }, 'OpenAIAgent: Finalizing response');
    }
    
    logger.info({ 
      answerLength: parsed.answer.trim().length,
      citationsCount: citations.length
    }, 'OpenAIAgent.generate: response parsed successfully');

    const result: AgentOutput = {
      answer: parsed.answer.trim(),
      citations: citations,
      model: this.model
    };
    
    return result;
  }
}

// Configuration constants
const CONFIG = {
  MAX_CONTENT_PER_EVIDENCE: 3000, // ~3KB per evidence item
  MAX_TOTAL_PROMPT_LENGTH: 50000, // ~50KB total prompt
  EVIDENCE_OVERHEAD: 200, // Overhead for question and formatting
  MIN_EVIDENCE_SPACE: 10000, // Minimum space reserved for evidence
  TRUNCATION_HEAD_LIMIT_OFFSET: 500, // Chars to reserve for tail when truncating
  MAX_QUESTION_LENGTH: 5000, // Maximum question length
  MAX_EVIDENCE_COUNT: 100 // Maximum evidence items
} as const;

// Debug mode flag (can be overridden for testing)
const DEBUG_MODE = env.DEBUG_OPENAI_AGENT || process.env.NODE_ENV === 'development';

function truncateEvidenceContent(content: string | null | undefined, maxLength: number): string | undefined {
  if (!content) {
    return undefined;
  }
  if (content.length <= maxLength) {
    return content;
  }
  // Truncate to maxLength, keeping beginning and end
  const headLimit = Math.max(maxLength - CONFIG.TRUNCATION_HEAD_LIMIT_OFFSET, 0);
  const head = headLimit > 0 ? content.slice(0, headLimit).trimEnd() : '';
  const tail = content.slice(-CONFIG.TRUNCATION_HEAD_LIMIT_OFFSET).trimStart();
  if (!head) {
    return tail;
  }
  return `${head}\n... [innhold forkortet] ...\n${tail}`;
}

function buildUserPrompt(question: string, evidence: AgentEvidence[]): string {
  if (evidence.length === 0) {
    return `Brukerspørsmål: ${question}\n\nIngen kilder ble funnet. Gi et forsiktig svar eller foreslå videre søk.`;
  }

  // Calculate available space for evidence (subtract question and formatting overhead)
  const questionAndOverhead = question.length + CONFIG.EVIDENCE_OVERHEAD;
  const availableForEvidence = Math.max(CONFIG.MAX_TOTAL_PROMPT_LENGTH - questionAndOverhead, CONFIG.MIN_EVIDENCE_SPACE);
  const maxContentPerItem = Math.min(CONFIG.MAX_CONTENT_PER_EVIDENCE, Math.floor(availableForEvidence / evidence.length));

  let totalLength = questionAndOverhead;
  const formattedEvidence = evidence
    .map(item => {
      // Truncate content to prevent excessive prompt size
      const truncatedContent = truncateEvidenceContent(item.content, maxContentPerItem);
      
      const parts = [
        `ID: ${item.id}`,
        `Kilde: ${item.source}`,
        item.title ? `Tittel: ${item.title}` : undefined,
        item.date ? `Dato: ${item.date}` : undefined,
        item.link ? `Lenke: ${item.link}` : undefined,
        item.snippet ? `Utdrag: ${item.snippet}` : undefined,
        truncatedContent ? `Innhold:\n${truncatedContent}` : undefined
      ].filter(Boolean);
      
      const formatted = parts.join('\n');
      // totalLength tracking removed - truncation handled by final check below
      
      return formatted;
    })
    .join('\n\n');

  const prompt = `Brukerspørsmål: ${question}\n\nTilgjengelige kilder:\n${formattedEvidence}\n\nInstruksjoner: Besvar spørsmålet ved å bruke kildene. Husk å returnere JSON-formatet som spesifisert.`;
  
  // Final safety check - if prompt is still too long, truncate the entire evidence section
  if (prompt.length > CONFIG.MAX_TOTAL_PROMPT_LENGTH) {
    logger.warn({ 
      promptLength: prompt.length, 
      maxLength: CONFIG.MAX_TOTAL_PROMPT_LENGTH,
      evidenceCount: evidence.length 
    }, 'buildUserPrompt: prompt exceeded max length, applying additional truncation');
    
    const questionPart = `Brukerspørsmål: ${question}\n\nTilgjengelige kilder:\n`;
    const instructionPart = `\n\nInstruksjoner: Besvar spørsmålet ved å bruke kildene. Husk å returnere JSON-formatet som spesifisert.`;
    const availableForEvidenceTruncated = CONFIG.MAX_TOTAL_PROMPT_LENGTH - questionPart.length - instructionPart.length;
    
    // Truncate each evidence item more aggressively
    const truncatedEvidence = evidence
      .map(item => {
        const veryTruncatedContent = truncateEvidenceContent(item.content, Math.floor(availableForEvidenceTruncated / evidence.length / 2));
        const parts = [
          `ID: ${item.id}`,
          `Kilde: ${item.source}`,
          item.title ? `Tittel: ${item.title}` : undefined,
          item.snippet ? `Utdrag: ${item.snippet}` : undefined,
          veryTruncatedContent ? `Innhold:\n${veryTruncatedContent}` : undefined
        ].filter(Boolean);
        return parts.join('\n');
      })
      .join('\n\n');
    
    return `${questionPart}${truncatedEvidence}${instructionPart}`;
  }
  
  return prompt;
}

function parseAgentJson(raw: string): { answer?: string; citations?: AgentOutput['citations'] } {
  try {
    const trimmed = raw.trim();
    const jsonStart = trimmed.indexOf('{');
    const jsonEnd = trimmed.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
      return { answer: trimmed };
    }
    const candidate = trimmed.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(candidate);
    return {
      answer: typeof parsed.answer === 'string' ? parsed.answer : undefined,
      citations: Array.isArray(parsed.citations) ? parsed.citations : undefined
    };
  } catch (error) {
    logger.warn({ err: error, raw }, 'Failed to parse agent JSON response');
    return { answer: raw };
  }
}

function normaliseCitation(entry: unknown): AgentOutputCitation | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const evidenceId = (entry as { evidenceId?: unknown }).evidenceId;
  const quote = (entry as { quote?: unknown }).quote;

  if (typeof evidenceId !== 'string') {
    return undefined;
  }

  return {
    evidenceId,
    // Don't set label here - it will be calculated based on position in the full evidence array
    label: `[${evidenceId}]`, // Temporary placeholder, will be replaced
    quote: typeof quote === 'string' ? quote : undefined
  };
}

