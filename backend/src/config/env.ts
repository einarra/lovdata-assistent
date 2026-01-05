import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

// Only write diagnostics in development or when DEBUG_ENV is set
const shouldDiag = process.env.NODE_ENV === 'development' || process.env.DEBUG_ENV === 'true';

// Write diagnostics only when needed
function writeDiag(msg: string) {
  if (shouldDiag) {
    // Use console.log instead of stderr for better visibility in Vercel logs if needed
    console.log(`[ENV] ${msg}`);
  }
}

// Resolve .env file path relative to the backend directory
// Strategy: Find directory containing package.json, which is the backend root
function findBackendRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  let currentDir = path.dirname(__filename);
  const startDir = currentDir;

  // Walk up the directory tree to find package.json
  for (let i = 0; i < 10; i++) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      // Reached filesystem root
      break;
    }
    currentDir = parent;
  }

  // Fallback: assume backend is two levels up from src/config or dist/config
  return path.resolve(startDir, '../..');
}

const backendDir = findBackendRoot();
const envPath = path.join(backendDir, '.env');
const cwdEnvPath = path.join(process.cwd(), '.env');

// Determine which .env file to load (prioritize cwd first, then backendDir)
// This is more reliable since apps are typically run from the backend directory
let envPathToLoad: string | undefined;
if (existsSync(cwdEnvPath)) {
  envPathToLoad = cwdEnvPath;
} else if (existsSync(envPath)) {
  envPathToLoad = envPath;
}

// Capture NODE_ENV from process.env before loading .env
// This ensures CLI arguments (e.g. NODE_ENV=development) take precedence over .env file
const cliNodeEnv = process.env.NODE_ENV;

// Load .env file if found, otherwise let dotenv search automatically
// Use override: true to ensure .env values take precedence over existing process.env
// In serverless (Vercel), .env files don't exist - env vars come from platform
const result = envPathToLoad
  ? dotenv.config({ path: envPathToLoad, override: true })
  : dotenv.config({ override: true });

// Restore NODE_ENV if it was set in CLI
if (cliNodeEnv) {
  process.env.NODE_ENV = cliNodeEnv;
}

if (result.error && shouldDiag) {
  writeDiag(`Error loading .env: ${result.error.message}`);
} else if (result.parsed && shouldDiag) {
  const keyCount = Object.keys(result.parsed).length;
  writeDiag(`Loaded ${keyCount} vars from .env file`);
}

// Verify that .env file was actually loaded and parsed (only warn in development)
if (envPathToLoad && result.parsed && Object.keys(result.parsed).length === 0 && shouldDiag) {
  console.warn(`[ENV] WARNING: .env file at ${envPathToLoad} exists but contains no parseable variables`);
}

// Debug output if requested
if (process.env.DEBUG_ENV) {
  console.log(`[ENV] Resolved backend directory: ${backendDir}`);
  console.log(`[ENV] Resolved .env path: ${envPath}`);
  console.log(`[ENV] Current working directory: ${process.cwd()}`);
  console.log(`[ENV] .env file loaded from: ${envPathToLoad || 'default dotenv search'}`);
  if (result.parsed) {
    console.log(`[ENV] Loaded ${Object.keys(result.parsed).length} variables from .env`);
    console.log(`[ENV] OPENAI_API_KEY in parsed: ${'OPENAI_API_KEY' in result.parsed}`);
    console.log(`[ENV] OPENAI_API_KEY length: ${result.parsed['OPENAI_API_KEY']?.length || 0}`);
  }
  console.log(`[ENV] OPENAI_API_KEY in process.env: ${'OPENAI_API_KEY' in process.env}`);
  console.log(`[ENV] OPENAI_API_KEY value length: ${process.env.OPENAI_API_KEY?.length || 0}`);
  console.log(`[ENV] OPENAI_API_KEY value (first 20 chars): ${process.env.OPENAI_API_KEY?.substring(0, 20) || 'undefined'}...`);
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default('info'),
  LOG_FILE: z.string().optional(),
  LOVDATA_BASE_URL: z
    .string()
    .url({ message: 'LOVDATA_BASE_URL must be a valid URL' })
    .default('https://api.lovdata.no'),
  LOVDATA_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  SERPER_API_KEY: z.string().optional(),
  SERPER_BASE_URL: z
    .string()
    .url({ message: 'SERPER_BASE_URL must be a valid URL' })
    .default('https://google.serper.dev/search'),
  SERPER_SITE_FILTER: z.string().default('lovdata.no'),
  PUBLIC_API_BASE_URL: z
    .string()
    .url({ message: 'PUBLIC_API_BASE_URL must be a valid URL' })
    .default('http://localhost:4000'),
  SUPABASE_URL: z.string().min(1, 'SUPABASE_URL is required'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  SUPABASE_ANON_KEY: z.string().optional(),
  SYNC_ARCHIVES_ON_STARTUP: z
    .string()
    .transform(val => val === 'true' || val === '1')
    .default('false'),
  OPENAI_API_KEY: z.string().optional().transform(val => val && val.trim() ? val.trim() : undefined),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_TEMPERATURE: z.coerce.number().min(0).max(2).default(1),
  OPENAI_AGENT_BASE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  OPENAI_AGENT_MAX_TIMEOUT_MS: z.coerce.number().int().positive().default(55000),
  DEBUG_OPENAI_AGENT: z.string().transform(val => val === 'true' || val === '1').default('false'),
  COHERE_API_KEY: z.string().optional().transform(val => val && val.trim() ? val.trim() : undefined),
  COHERE_BASE_URL: z.string().url().optional().default('https://api.cohere.ai/v1'),
  ENABLE_RERANKING: z.string().transform(val => val === 'true' || val === '1').default('true'),
  RRF_K: z.coerce.number().int().positive().default(40), // RRF constant for hybrid search (lower = more differentiation between ranks, typical range: 20-60)
  LANGSMITH_API_KEY: z.string().optional(),
  LANGSMITH_PROJECT: z.string().optional(),
  LANGSMITH_ENDPOINT: z.string().optional(),
  ALLOWED_ORIGINS: z.string().optional() // Comma-separated list of allowed CORS origins
});

// Debug: Check process.env before parsing
if (process.env.DEBUG_ENV) {
  console.log(`[ENV] process.env.OPENAI_API_KEY exists: ${'OPENAI_API_KEY' in process.env}`);
  console.log(`[ENV] process.env.OPENAI_API_KEY value length: ${process.env.OPENAI_API_KEY?.length || 0}`);
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.errors
    .map(err => `${err.path.join('.') || 'env'}: ${err.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

const envData = parsed.data;

// Warn if OPENAI_API_KEY is missing (unless we're in test mode)
if (!envData.OPENAI_API_KEY && envData.NODE_ENV !== 'test' && shouldDiag) {
  console.warn('[ENV] OPENAI_API_KEY is not set. OpenAI agent will not be available.');
}

// Debug: Check parsed data
if (process.env.DEBUG_ENV) {
  console.log(`[ENV] envData.OPENAI_API_KEY exists: ${'OPENAI_API_KEY' in envData}`);
  console.log(`[ENV] envData.OPENAI_API_KEY value: ${envData.OPENAI_API_KEY ? `exists (length: ${envData.OPENAI_API_KEY.length})` : 'undefined'}`);
}

if (envData.NODE_ENV === 'production') {
  const prodErrors: string[] = [];

  if (!envData.OPENAI_API_KEY) {
    prodErrors.push('OPENAI_API_KEY must be set in production.');
  }

  if (envData.PUBLIC_API_BASE_URL.includes('localhost') || envData.PUBLIC_API_BASE_URL.includes('127.0.0.1')) {
    prodErrors.push('PUBLIC_API_BASE_URL must not point to localhost in production.');
  }

  if (envData.LOVDATA_BASE_URL.includes('localhost') || envData.LOVDATA_BASE_URL.startsWith('http://')) {
    prodErrors.push('LOVDATA_BASE_URL should use HTTPS and must not point to localhost in production.');
  }

  if (prodErrors.length > 0) {
    throw new Error(`Invalid production environment configuration:\n${prodErrors.join('\n')}`);
  }
}

export const env = envData;
export type Env = typeof env;
