/**
 * OpenAI function calling schema for lovdata-serper skill.
 * This defines the function that the agent can call to search legal practice documents.
 */

export const lovdataSerperFunction = {
  name: 'search_lovdata_legal_practice',
  description: `Søk direkte på lovdata.no for å finne lover, sentrale forskrifter, rettsavgjørelser og kunngjøringer. 

VIKTIG: Denne funksjonen gir deg direkte lenker til dokumenter på lovdata.no som automatisk inkluderes i evidence-listen. Alle lenker peker direkte til dokumentene, ikke søkesider.

PRIORITERT KILDE - RETTSAVGJØRELSER:
Rettsavgjørelser er en prioritert kilde til informasjon for å forstå hvordan lover og forskrifter anvendes i praksis. Når brukeren spør om praktisk anvendelse, tolkning, eller "hvordan" noe fungerer, skal du prioritere å finne rettsavgjørelser.

DOKUMENTTYPER:
Denne funksjonen søker på spesifikke register-sider på lovdata.no basert på dokumenttype:
- "lov": Søker på https://lovdata.no/register/lover for å finne lover
- "forskrift": Søker på https://lovdata.no/register/forskrifter for å finne sentrale forskrifter
- "avgjørelse": Søker på https://lovdata.no/register/avgjørelser for å finne rettsavgjørelser og dommer (PRIORITERT for praktisk anvendelse)
- "kunngjøring": Søker på https://lovdata.no/register/lovtidend for å finne kunngjøringer i Lovtidend

Bruk denne funksjonen for å finne:
- Rettsavgjørelser og dommer (PRIORITERT) - viktigste kilden for praktisk anvendelse og tolkning
- Lover publisert på lovdata.no
- Sentrale forskrifter publisert på lovdata.no
- Kunngjøringer i Lovtidend
- Praktiske eksempler på tolking og anvendelse av lovtekster
- Kontekst om hvordan rettsregler brukes i praksis

SØK PÅ NYTT VED BEHOV:
- Hvis første søk ikke gir relevante resultater, kan du søke på nytt med forbedrede søkeord
- Hvis brukeren ber om mer informasjon, spesifikke eksempler, eller gir tilleggsinformasjon, kan du søke på nytt
- Du kan søke flere ganger med ulike dokumenttyper eller vinklinger for å finne bedre resultater

Bruk denne i kombinasjon med search_lovdata_legal_documents for å gi både lovtekster fra offentlige data og dokumenter fra lovdata.no. Dette gir deg både lovtekster og praktiske eksempler med direkte lenker til dokumentene.`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Søkeordene basert på brukerens spørsmål. Bruk lovnavn (f.eks. "arveloven", "arbeidsmiljøloven"), juridiske termer, eller emner du vil finne lover, forskrifter eller rettspraksis for. Ekstraher relevante søkeord fra brukerens spørsmål.'
      },
      documentType: {
        type: 'string',
        enum: ['lov', 'forskrift', 'avgjørelse', 'kunngjøring'],
        description: 'Type dokument å søke etter. "lov" for lover, "forskrift" for sentrale forskrifter, "avgjørelse" for rettsavgjørelser (prioritert for praktisk anvendelse), "kunngjøring" for kunngjøringer i Lovtidend. Hvis ikke spesifisert, brukes "avgjørelse" som standard for å prioritere rettsavgjørelser.'
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

