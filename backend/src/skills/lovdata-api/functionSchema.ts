/**
 * OpenAI function calling schema for lovdata-api skill.
 * This defines the function that the agent can call to search legal documents.
 */

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
        description: 'År for dokumentet. VIKTIG: For søk etter lover og forskrifter, sett year til minst 2021 (siste 5 år) med mindre brukeren eksplisitt ber om eldre dokumenter eller spesifiserer et annet år. Hvis brukeren nevner et år (f.eks. "2023", "fra 2020"), bruk det året. Hvis ikke spesifisert og du søker etter lover/forskrifter, bruk 2021 eller nyere.'
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
} as const;

