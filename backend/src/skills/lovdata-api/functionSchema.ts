/**
 * OpenAI function calling schema for lovdata-api skill.
 * This defines the function that the agent can call to search legal documents.
 */

export const lovdataSearchFunction = {
  name: 'search_lovdata_legal_documents',
  description: `PRIORITET 2 - BRUK VED BEHOV: Søk gjennom Lovdata juridiske dokumenter fra offentlige data-arkiver. Bruk denne funksjonen sekundært når du trenger å undersøke lovendringer og oppdateringer.

VIKTIG: Dette er din sekundære søkefunksjon. Bruk search_lovdata_legal_practice FØRST for alle spørsmål. Bruk denne funksjonen kun når du trenger:
- Spesifikke lovendringer ("Lov om endring i...")
- Oppdateringer til eksisterende lover
- Detaljerte lovtekster fra offentlige data-arkiver
- Sammenligning av forskjellige versjoner av en lov

Prioritering av lawType parameter (søk i denne rekkefølgen hvis brukerens spørsmål ikke spesifiserer type):
1. Lov (lover/acts) - høyest prioritet
2. Forskrift (regulations)
3. Vedtak (decisions)
4. Instruks (instructions)
5. Reglement (regulations/regulations)
6. Vedlegg (annexes) - lavest prioritet

VIKTIG: Når du får søkeresultater, evaluer dem først:
- Sjekk om resultatene faktisk svarer på brukerens spørsmål basert på titler og utdrag
- Hvis resultatene er irrelevante eller ikke gir nok informasjon, forbedre søkeordene og søk på nytt
- Bruk mer spesifikke søkeord, prøv andre dokumenttyper, eller juster år-filteret hvis nødvendig
- Du kan søke flere ganger for å finne bedre resultater før du går videre`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Velg relevante søkeord basert på brukerens spørsmål. Ekstraher relevante juridiske termer.'
      },
      lawType: {
        type: 'string',
        enum: ['Lov', 'Forskrift', 'Vedtak', 'Instruks', 'Reglement', 'Vedlegg'],
        description: 'lawType parameter. Hvis ikke spesifisert i spørsmålet, start med "Lov" og "Forskrift" og prøv andre typer hvis nødvendig.'
      },
      year: {
        type: 'number',
        description: 'År for dokumentet',
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

