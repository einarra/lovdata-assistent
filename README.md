# Lovdata Assistant

Fullstack-applikasjon for juridiske søk og svar med data fra Lovdata. Prosjektet består av:

- `backend/`: Node.js/TypeScript-tjeneste som håndterer søk i Lovdata-data, agent-kall mot OpenAI og REST-endepunkter.
- `frontend/`: React/Vite-applikasjon som tilbyr brukergrensesnittet for å stille spørsmål og vise svar.

## Arkitektur

| Lag        | Teknologi                           | Beskrivelse |
|------------|-------------------------------------|-------------|
| Backend    | Node.js, Express, TypeScript, tsx   | Kjører ferdigdefinerte skills mot Lovdata, orkestrerer assistenten og eksponerer API-endepunkter (`/assistant/run`, `/skills/run`, osv.). |
| Frontend   | React, TypeScript, Vite             | Forbruker backend-API-et og presenterer UI for spørsmål/svar. |
| AI-agent   | OpenAI Responses API                | Genererer svar basert på hydrerte Lovdata-dokumenter. |

## Kom i gang

### Forutsetninger

- Node.js ≥ 20
- npm ≥ 10
- (Valgfritt) Docker om du vil containerisere løsningen

### Installer avhengigheter

```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### Miljøvariabler

- Kopier `backend/env.example` → `backend/.env` og `frontend/env.example` → `frontend/.env`.
- Fyll inn hemmeligheter via hemmelighetshåndtering (ikke sjekk inn `.env`-filer).
- Viktige nøkler:
  - `OPENAI_API_KEY` – kreves i produksjon
  - `SESSION_SECRET` – minimum 32 tegn for sikre cookies
  - `STRIPE_API_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` – aktiver abonnement
  - `PUBLIC_API_BASE_URL` – ekstern URL for backend (ikke localhost i prod)
  - `LOVDATA_BASE_URL` – upstream Lovdata API (standard `https://api.lovdata.no`)
  - `VITE_API_URL`, `VITE_STRIPE_PUBLISHABLE_KEY` – frontend peker til backend og Stripe
- Backend feiler oppstart i produksjon dersom essensielle nøkler mangler.

### Kjør lokalt

```bash
# Backend – utviklingsmodus med live reload
cd backend
npm run dev

# Frontend – utviklingsserver (standard på http://localhost:5173)
cd ../frontend
npm run dev
```

Frontend forventer at backend lytter på port `4000`. Juster `VITE_API_BASE_URL` hvis backend kjører et annet sted.

### Bygg for produksjon

```bash
cd backend
npm run build

cd ../frontend
npm run build
```

Backend genererer JavaScript i `dist/`, frontend bygges til `dist/` og kan hostes som statiske filer.

## Testing og kvalitet

```bash
cd backend
npm run lint
npm test

cd ../frontend
npm run lint
npm test   # dersom testsuite er konfigurert
```

## Distribusjon

### Vercel (Anbefalt)

Prosjektet er konfigurert for produksjonsdeploy på Vercel. Se [VERCEL_DEPLOYMENT.md](./VERCEL_DEPLOYMENT.md) for detaljert guide.

**Hurtigstart:**
1. Koble Git-repository til Vercel
2. Sett opp miljøvariabler i Vercel Dashboard
3. Deploy skjer automatisk ved push til main branch

### Andre plattformer

1. Sørg for at nødvendige hemmeligheter er tilgjengelige for runtime (OpenAI, Lovdata API, Stripe, LangSmith etc.).
2. Bygg både backend og frontend.
3. Deploy backend som Node-app (container, PM2, serverless e.l.).
4. Server frontend-dist som statiske filer (Netlify, Nginx, etc.) og pek den mot backend-URL-en.

## Videre arbeid

- Sett opp CI/CD for lint/test/build.
- Legg til logging/observability etter produksjonsbehov.
- Hold `.env`-filer utenfor git – bruk `backend/env.example` og `frontend/env.example` som maler ved behov.
- Les gjennom `docs/security/threat-model.md` og `docs/security/compliance.md` før produksjonssetting.
- Sett opp Stripe Checkout + Customer Portal og webhooken (`/billing/webhook`) for abonnementshåndtering.
