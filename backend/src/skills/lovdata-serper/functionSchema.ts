/**
 * OpenAI function calling schema for lovdata-serper skill.
 * This defines the function that the agent can call to search legal practice documents.
 */

export const lovdataSerperFunction = {
  name: 'search_lovdata_legal_practice',
  description: `PRIORITET 1 - BRUK DETTE FØRST: Søk direkte på lovdata.no for å finne lover, sentrale forskrifter, artikler og kunngjøringer. 

VIKTIG: Dette er din primære søkefunksjon - bruk denne FØRST for alle spørsmål. Denne funksjonen gir deg direkte lenker til dokumenter på lovdata.no som automatisk inkluderes i evidence-listen. 

SØKEMETODE:
Denne funksjonen søker på hele lovdata.no og finner relevante dokumenter basert på søkeordene. Søket fokuserer på å finne direkte lenker til dokumenter (lover, forskrifter, rettsavgjørelser, kunngjøringer) og ekskluderer søkesider og register-sider.

Bruk denne funksjonen for å finne:
- Lover publisert på lovdata.no 
- Sentrale forskrifter publisert på lovdata.no
- Kunngjøringer i Lovtidend
- Artikler og rettsavgjørelser som eksempler på tolking og anvendelse av lovtekster
- Kontekst om hvordan rettsregler brukes i praksis


Hvis du trenger å undersøke lovendringer eller oppdateringer, kan du også bruke search_lovdata_legal_documents som sekundær søkefunksjon.`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Søkeordene basert på brukerens spørsmål. Bruk lovnavn (f.eks. "arveloven", "arbeidsmiljøloven"), juridiske termer, eller emner du vil finne lover, forskrifter eller rettspraksis for. Ekstraher relevante søkeord fra brukerens spørsmål. For rettsavgjørelser, inkluder relevante juridiske termer og lovnavn.'
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

