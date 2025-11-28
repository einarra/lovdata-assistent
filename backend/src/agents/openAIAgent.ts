import OpenAI from 'openai';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import type { Agent, AgentEvidence, AgentInput, AgentOutput } from './types.js';

const SYSTEM_PROMPT = `Du er en juridisk assistent som bruker dokumenter fra Lovdatas offentlige data.
Svar alltid på norsk med et presist, nøkternt språk.

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
      timeout: 6000, // 6 seconds client-level timeout (slightly longer than our Promise.race timeout of 5s)
      maxRetries: 0 // Disable retries to avoid delays
    });
    this.model = options.model ?? env.OPENAI_MODEL;
    this.temperature = options.temperature ?? env.OPENAI_TEMPERATURE;
  }

  async generate(input: AgentInput): Promise<AgentOutput> {
    const prompt = buildUserPrompt(input.question, input.evidence);
    
    // Validate model name - "gpt-5" is not a valid OpenAI model and may cause hangs
    const knownValidModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'];
    if (!knownValidModels.includes(this.model)) {
      logger.warn({ 
        model: this.model,
        knownValidModels 
      }, 'OpenAIAgent.generate: model name not in known valid list - this may cause the API to hang or fail. Common valid models: gpt-4o-mini, gpt-4o, gpt-4-turbo');
    }
    
    logger.info({ 
      question: input.question,
      evidenceCount: input.evidence.length,
      model: this.model
    }, 'OpenAIAgent.generate: starting API call');

    // Add timeout to prevent hanging
    // We've typically used 2-3 seconds so far (database + Serper + evidence)
    // Vercel Pro has 60s timeout
    // OpenAI API calls typically take 3-5 seconds, especially with large prompts
    // Use 5 seconds for OpenAI call - this allows enough time for the API while still leaving buffer
    // Total function time: ~2.7s (current) + 5s (OpenAI) = ~7.7s, well under 60s limit
    const timeoutMs = 5000; // 5 seconds - allows OpenAI API to complete while leaving buffer before Vercel Pro 60s timeout
    const startTime = Date.now();
    const controller = new AbortController();

    // Add progress checks while waiting for OpenAI API
    console.log(`[OpenAIAgent] Setting up progress checks...`);
    const progressCheckInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      console.log(`[OpenAIAgent] Still waiting for OpenAI response... elapsed: ${elapsed}ms, timeout at: ${timeoutMs}ms`);
    }, 1000); // Check every 1 second to monitor progress
    
    // Add safety checks at 1s, 2s, 3s, and 4s to monitor progress (timeout is 5s)
    const safetyCheck1s = setTimeout(() => {
      const elapsed = Date.now() - startTime;
      console.log(`[OpenAIAgent] Safety check at 1s - elapsed: ${elapsed}ms, timeout will trigger in ~${timeoutMs - elapsed}ms`);
    }, 1000);
    
    const safetyCheck2s = setTimeout(() => {
      const elapsed = Date.now() - startTime;
      console.log(`[OpenAIAgent] Safety check at 2s - elapsed: ${elapsed}ms, timeout will trigger in ~${timeoutMs - elapsed}ms`);
    }, 2000);
    
    const safetyCheck3s = setTimeout(() => {
      const elapsed = Date.now() - startTime;
      console.log(`[OpenAIAgent] Safety check at 3s - elapsed: ${elapsed}ms, timeout will trigger in ~${timeoutMs - elapsed}ms`);
    }, 3000);
    
    const safetyCheck4s = setTimeout(() => {
      const elapsed = Date.now() - startTime;
      console.log(`[OpenAIAgent] Safety check at 4s - elapsed: ${elapsed}ms, timeout will trigger in ~${timeoutMs - elapsed}ms`);
    }, 4000);
    
    const specificChecks: NodeJS.Timeout[] = [safetyCheck1s, safetyCheck2s, safetyCheck3s, safetyCheck4s];

    let response;
    try {
      console.log(`[OpenAIAgent] Starting API call, timeout: ${timeoutMs}ms`);
      logger.info({ timeoutMs }, 'OpenAIAgent.generate: calling OpenAI API');
      console.log(`[OpenAIAgent] About to call OpenAI API with AbortController signal`);
      
      // Create the API call promise
      // Log before creating the promise to see if we get here
      console.log(`[OpenAIAgent] About to create chat.completions.create call...`);
      console.log(`[OpenAIAgent] Model: ${this.model}, prompt length: ${prompt.length}, evidence count: ${input.evidence.length}`);
      
      const apiCallPromise = this.client.chat.completions.create(
        {
          model: this.model,
          temperature: this.temperature,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt }
          ],
          response_format: { type: 'json_object' },
          max_tokens: 1000 // Limit tokens to ensure faster response
        },
        {
          signal: controller.signal
        }
      ).catch(error => {
        // Log immediately if the promise rejects
        const elapsed = Date.now() - startTime;
        console.log(`[OpenAIAgent] API call promise rejected immediately after ${elapsed}ms:`, error instanceof Error ? error.message : String(error));
        throw error;
      });
      
      console.log(`[OpenAIAgent] chat.completions.create promise created (not awaited yet)`);
      
      // Create a timeout promise that will reject if the API call takes too long
      // Use a separate timeout ID so we can log when it's set up
      // Create the timeout OUTSIDE the Promise constructor to ensure it's set immediately
      console.log(`[OpenAIAgent] Creating timeout promise, will trigger in ${timeoutMs}ms`);
      let timeoutId: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        // Add immediate logging before setting timeout
        console.log(`[OpenAIAgent] About to set timeout for ${timeoutMs}ms`);
        timeoutId = setTimeout(() => {
          const elapsed = Date.now() - startTime;
          // Use console.log for immediate visibility (logger might not flush)
          console.log(`[OpenAIAgent] ========== TIMEOUT PROMISE TRIGGERED after ${elapsed}ms ==========`);
          console.log(`[OpenAIAgent] Timeout callback executing, aborting controller...`);
          logger.error({ elapsedMs: elapsed, timeoutMs }, 'OpenAIAgent.generate: timeout triggered');
          controller.abort();
          console.log(`[OpenAIAgent] Controller aborted, rejecting promise...`);
          reject(new Error(`OpenAI API call timed out after ${timeoutMs}ms`));
          console.log(`[OpenAIAgent] Promise rejected in timeout callback`);
        }, timeoutMs);
        console.log(`[OpenAIAgent] Timeout promise created, timeoutId: ${timeoutId ? 'set' : 'not set'}`);
        // Add a log right after setting the timeout to confirm it's scheduled
        if (timeoutId) {
          console.log(`[OpenAIAgent] Timeout scheduled successfully, will fire in ${timeoutMs}ms`);
        }
      });
      
      console.log(`[OpenAIAgent] API call promise created, awaiting response with Promise.race...`);
      console.log(`[OpenAIAgent] About to await Promise.race([apiCallPromise, timeoutPromise])`);
      
      // Use Promise.race to ensure timeout always triggers
      // Add a wrapper to log which promise resolves first
      const racePromise = Promise.race([
        apiCallPromise.then(result => {
          const elapsed = Date.now() - startTime;
          console.log(`[OpenAIAgent] API call promise resolved first after ${elapsed}ms`);
          return result;
        }),
        timeoutPromise.catch(error => {
          const elapsed = Date.now() - startTime;
          console.log(`[OpenAIAgent] Timeout promise rejected first after ${elapsed}ms`);
          throw error;
        })
      ]);
      
      console.log(`[OpenAIAgent] Promise.race created, awaiting result...`);
      
      // Add an immediate check to confirm we're actually awaiting
      setTimeout(() => {
        const elapsed = Date.now() - startTime;
        console.log(`[OpenAIAgent] Immediate check (0.5s) - elapsed: ${elapsed}ms, still awaiting...`);
      }, 500);
      
      // Wrap the await in a try-catch with more detailed logging
      try {
        console.log(`[OpenAIAgent] About to await racePromise...`);
        response = await racePromise;
        console.log(`[OpenAIAgent] racePromise resolved successfully`);
      } catch (raceError) {
        const elapsed = Date.now() - startTime;
        console.log(`[OpenAIAgent] racePromise rejected after ${elapsed}ms:`, raceError instanceof Error ? raceError.message : String(raceError));
        throw raceError;
      }
      
      // Clear all timeouts and intervals
      clearInterval(progressCheckInterval);
      specificChecks.forEach(clearTimeout);
      console.log(`[OpenAIAgent] Progress checks cleared`);
      
      const elapsed = Date.now() - startTime;
      console.log(`[OpenAIAgent] API call completed after ${elapsed}ms`);
      logger.info({ 
        hasResponse: !!response,
        choicesCount: response?.choices?.length ?? 0,
        elapsedMs: elapsed
      }, 'OpenAIAgent.generate: OpenAI API call completed');
    } catch (error) {
      // Clear all timeouts and intervals
      clearInterval(progressCheckInterval);
      specificChecks.forEach(clearTimeout);
      const elapsed = Date.now() - startTime;
      console.log(`[OpenAIAgent] Catch block entered after ${elapsed}ms`);
      console.log(`[OpenAIAgent] API call failed after ${elapsed}ms:`, error instanceof Error ? error.message : String(error));
      
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

    const raw = response.choices[0]?.message?.content ?? '';
    console.log(`[OpenAIAgent] Response received, raw length: ${raw.length}`);
    logger.info({ rawLength: raw.length }, 'OpenAIAgent.generate: parsing response');
    
    let parsed;
    try {
      parsed = parseAgentJson(raw);
      console.log(`[OpenAIAgent] Response parsed successfully, hasAnswer: ${!!parsed.answer}`);
      logger.debug({ hasAnswer: !!parsed.answer }, 'OpenAIAgent.generate: JSON parsed');
    } catch (parseError) {
      console.log(`[OpenAIAgent] Parse error:`, parseError instanceof Error ? parseError.message : String(parseError));
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

    const citations = Array.isArray(parsed.citations)
      ? parsed.citations
          .map((entry: unknown) => normaliseCitation(entry))
          .filter(
            (entry: AgentOutput['citations'][number] | undefined): entry is AgentOutput['citations'][number] =>
              Boolean(entry)
          )
      : undefined;

    console.log(`[OpenAIAgent] Finalizing response, answer length: ${parsed.answer.trim().length}, citations: ${citations?.length ?? 0}`);
    logger.info({ 
      answerLength: parsed.answer.trim().length,
      citationsCount: citations?.length ?? 0
    }, 'OpenAIAgent.generate: response parsed successfully');

    const result = {
      answer: parsed.answer.trim(),
      citations: citations ?? [],
      model: this.model
    };
    
    console.log(`[OpenAIAgent] Returning result, answer length: ${result.answer.length}`);
    return result;
  }
}

function buildUserPrompt(question: string, evidence: AgentEvidence[]): string {
  if (evidence.length === 0) {
    return `Brukerspørsmål: ${question}\n\nIngen kilder ble funnet. Gi et forsiktig svar eller foreslå videre søk.`;
  }

  const formattedEvidence = evidence
    .map(item => {
      const parts = [
        `ID: ${item.id}`,
        `Kilde: ${item.source}`,
        item.title ? `Tittel: ${item.title}` : undefined,
        item.date ? `Dato: ${item.date}` : undefined,
        item.link ? `Lenke: ${item.link}` : undefined,
        item.snippet ? `Utdrag: ${item.snippet}` : undefined,
        item.content ? `Innhold:\n${item.content}` : undefined
      ].filter(Boolean);
      return parts.join('\n');
    })
    .join('\n\n');

  return `Brukerspørsmål: ${question}\n\nTilgjengelige kilder:\n${formattedEvidence}\n\nInstruksjoner: Besvar spørsmålet ved å bruke kildene. Husk å returnere JSON-formatet som spesifisert.`;
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

function normaliseCitation(entry: unknown): AgentOutput['citations'][number] | undefined {
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

