/**
 * OpenAI function calling schema for lovdata-serper skill.
 * This defines the function that the agent can call to search legal practice documents.
 */

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
} as const;

