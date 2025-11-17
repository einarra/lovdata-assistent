# Lovdata Assistant Frontend

React + TypeScript frontend for the Lovdata OpenAI agent.

## Features

- 🎨 Modern, responsivt chatgrensesnitt
- 💬 Chat med Supabase-beskyttet backend
- 🔐 Støtte for både magisk lenke og passordinnlogging
- 📱 Mobilvennlig design
- ⚡ Rask og responsiv opplevelse

## Prerequisites

- Node.js 18+ and npm
- The backend server running on `http://localhost:4000`

## Installation

```bash
cd frontend
npm install
```

## Development

Start the development server:

```bash
npm run dev
```

The app will be available at `http://localhost:5173` (or the port shown in the terminal).

## Environment Variables

Create a `.env` file in the `frontend` directory:

```env
VITE_API_URL=http://localhost:4000
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=replace-me
```

## Build

Build for production:

```bash
npm run build
```

The built files will be in the `dist` directory.

## Project Structure

```
frontend/
├── src/
│   ├── components/      # React components
│   │   ├── ChatWindow.tsx
│   │   ├── ChatInput.tsx
│   │   └── ChatMessage.tsx
│   ├── services/        # API services
│   │   └── api.ts
│   ├── types/           # TypeScript types
│   │   └── chat.ts
│   ├── App.tsx          # Main app component
│   └── main.tsx         # Entry point
├── public/              # Static assets
└── package.json
```

## Usage

1. Make sure the agent API server is running (`agent_api.py`)
2. Start the frontend development server
3. Open the app in your browser
4. Logg inn med enten magisk lenke eller passord (for brukere du har lagt inn manuelt)
5. Start chatting med Lovdata-assistenten!

## Technologies

- **React 19** - UI library
- **TypeScript** - Type safety
- **Vite** - Build tool and dev server
- **CSS3** - Styling
