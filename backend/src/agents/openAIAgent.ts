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
    this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    this.model = options.model ?? env.OPENAI_MODEL;
    this.temperature = options.temperature ?? env.OPENAI_TEMPERATURE;
  }

  async generate(input: AgentInput): Promise<AgentOutput> {
    const prompt = buildUserPrompt(input.question, input.evidence);

    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: this.temperature,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }
    });

    const raw = response.choices[0]?.message?.content ?? '';
    const parsed = parseAgentJson(raw);
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

    return {
      answer: parsed.answer.trim(),
      citations: citations ?? [],
      model: this.model
    };
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

