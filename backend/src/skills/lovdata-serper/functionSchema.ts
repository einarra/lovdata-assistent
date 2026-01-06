/**
 * OpenAI function calling schema for lovdata-serper skill.
 * This defines the function that the agent can call to search legal practice documents.
 */

export const lovdataSerperFunction = {
  name: 'search_lovdata_legal_practice',
  description: `Søk direkte på lovdata.no for å finne lover, sentrale forskrifter, artikler og kunngjøringer. 

VIKTIG: Denne funksjonen gir deg direkte lenker til dokumenter på lovdata.no som automatisk inkluderes i evidence-listen. Alle lenker peker direkte til dokumentene, ikke søkesider.


SØKEMETODE:
Denne funksjonen søker på hele lovdata.no og finner relevante dokumenter basert på søkeordene. Søket fokuserer på å finne direkte lenker til dokumenter (lover, forskrifter, rettsavgjørelser, kunngjøringer) og ekskluderer søkesider og register-sider.

Bruk denne funksjonen for å finne:
- Lover publisert på lovdata.no
- Sentrale forskrifter publisert på lovdata.no
- Kunngjøringer i Lovtidend
- Artikler og eksempler på tolking og anvendelse av lovtekster
- Kontekst om hvordan rettsregler brukes i praksis

SØK PÅ NYTT VED BEHOV:
- Hvis første søk ikke gir relevante resultater, kan du søke på nytt med forbedrede søkeord
- Hvis brukeren ber om mer informasjon, spesifikke eksempler, eller gir tilleggsinformasjon, kan du søke på nytt
- Du kan søke flere ganger med ulike vinklinger eller mer spesifikke søkeord for å finne bedre resultater

Bruk denne i kombinasjon med search_lovdata_legal_documents for å gi både lovtekster fra offentlige data og dokumenter fra lovdata.no. Dette gir deg både lovtekster og praktiske eksempler med direkte lenker til dokumentene.`,
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

