import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, writeFileSync, readFileSync } from 'fs';

// Write diagnostics to a file so we can always see them
// In serverless environments (Vercel, AWS Lambda), filesystem is read-only except /tmp
function writeDiag(msg: string) {
  // Check if we're in a serverless environment
  const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.cwd().startsWith('/var/task');
  
  // Always write to stderr (visible in logs)
  process.stderr.write(`[DIAG] ${msg}\n`);
  
  // Only try to write to file if not in serverless environment
  if (!isServerless) {
    try {
      const cwd = process.cwd();
      const diagFile = path.join(cwd, 'env-debug.log');
      const content = `${new Date().toISOString()}: ${msg}\n`;
      writeFileSync(diagFile, content, { flag: 'a' });
    } catch (e: unknown) {
      // Silently ignore file write errors in serverless (expected)
      // Error already logged to stderr above
    }
  }
}

writeDiag('ENV.TS MODULE LOADING');
// Force output to stderr immediately - should be visible no matter what
process.stderr.write('\n=== ENV.TS STARTING ===\n');

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

// Load .env file if found, otherwise let dotenv search automatically
// Use override: true to ensure .env values take precedence over existing process.env
// ALWAYS write to stderr so these messages are visible even if stdout is captured
const result = envPathToLoad 
  ? dotenv.config({ path: envPathToLoad, override: true })
  : dotenv.config({ override: true });

// Write diagnostic info to file AND console
writeDiag(`Attempting to load .env from: ${envPathToLoad || 'default search'}`);
writeDiag(`Resolved backend dir: ${backendDir}`);
writeDiag(`Checked path 1: ${envPath}`);
writeDiag(`Checked path 2: ${cwdEnvPath}`);
writeDiag(`Current working dir: ${process.cwd()}`);

if (result.error) {
  writeDiag(`ERROR loading .env: ${result.error.message}`);
} else if (result.parsed) {
  const keyCount = Object.keys(result.parsed).length;
  writeDiag(`✓ Loaded ${keyCount} vars from .env file`);
  writeDiag(`OPENAI_API_KEY in parsed result: ${'OPENAI_API_KEY' in result.parsed}`);
  if (result.parsed['OPENAI_API_KEY']) {
    writeDiag(`✓ OPENAI_API_KEY found in parsed! Length: ${result.parsed['OPENAI_API_KEY'].length}`);
  } else {
    writeDiag(`✗ OPENAI_API_KEY NOT in parsed result`);
    writeDiag(`First 10 keys loaded: ${Object.keys(result.parsed).slice(0, 10).join(', ')}`);
  }
} else {
  writeDiag(`✗ No .env file found or parsed`);
}

writeDiag(`process.env.OPENAI_API_KEY after load: ${process.env.OPENAI_API_KEY ? `EXISTS (length: ${process.env.OPENAI_API_KEY.length})` : 'MISSING'}`);

// Verify that .env file was actually loaded and parsed
if (envPathToLoad && result.parsed && Object.keys(result.parsed).length === 0) {
  writeDiag(`⚠ WARNING: .env file exists at ${envPathToLoad} but appears to be empty or unparseable`);
  console.warn(`[ENV] WARNING: .env file at ${envPathToLoad} exists but contains no parseable variables`);
}

// Always log the result for transparency
if (result.error) {
  console.error(`[ENV] ERROR: Failed to load .env file${envPathToLoad ? ` from ${envPathToLoad}` : ''}: ${result.error.message}`);
} else if (result.parsed && Object.keys(result.parsed).length > 0) {
  console.log(`[ENV] Successfully loaded ${Object.keys(result.parsed).length} environment variables from .env file${envPathToLoad ? ` (${envPathToLoad})` : ''}`);
  // Immediately verify OPENAI_API_KEY was loaded
  const openaiKeyInParsed = 'OPENAI_API_KEY' in result.parsed && result.parsed['OPENAI_API_KEY'];
  const openaiKeyInProcessEnv = process.env.OPENAI_API_KEY;
  
  if (openaiKeyInParsed) {
    console.log(`[ENV] ✓ OPENAI_API_KEY loaded successfully (length: ${result.parsed['OPENAI_API_KEY'].length})`);
  } else if (openaiKeyInProcessEnv) {
    console.warn(`[ENV] ⚠ OPENAI_API_KEY exists in process.env but was not in .env file (length: ${openaiKeyInProcessEnv.length})`);
  } else {
    console.error(`[ENV] ✗ OPENAI_API_KEY NOT FOUND in .env file${envPathToLoad ? ` at ${envPathToLoad}` : ''}`);
    console.error(`[ENV] Checked path: ${envPath}`);
    console.error(`[ENV] Checked path: ${cwdEnvPath}`);
    // List what keys were actually loaded
    const loadedKeys = Object.keys(result.parsed).slice(0, 10);
    console.error(`[ENV] First 10 keys loaded: ${loadedKeys.join(', ')}`);
  }
} else if (!envPathToLoad) {
  // Only warn if we explicitly looked for a file but didn't find one
  console.error(`[ENV] ERROR: No .env file found. Tried: ${envPath}, ${cwdEnvPath}, and default dotenv search.`);
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
  LANGSMITH_API_KEY: z.string().optional(),
  LANGSMITH_PROJECT: z.string().optional(),
  LANGSMITH_ENDPOINT: z.string().optional()
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

// Always warn if OPENAI_API_KEY is missing (unless we're in test mode)
if (!envData.OPENAI_API_KEY && envData.NODE_ENV !== 'test') {
  writeDiag(`✗✗✗ CRITICAL: OPENAI_API_KEY is not set in envData. OpenAI agent will not be available.`);
  writeDiag(`Checked .env file location: ${envPathToLoad || envPath || 'not found'}`);
  writeDiag(`Current working directory: ${process.cwd()}`);
  writeDiag(`Backend directory: ${backendDir}`);
  writeDiag(`process.env.OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? `EXISTS (length: ${process.env.OPENAI_API_KEY.length})` : 'UNDEFINED'}`);
  writeDiag(`envData.OPENAI_API_KEY: ${envData.OPENAI_API_KEY || 'UNDEFINED'}`);
  writeDiag(`This means either: 1) .env file not loaded, 2) Key not in .env file, 3) Key is empty/whitespace, or 4) Zod schema filtered it out`);
  
  // Additional diagnostic: check if .env file exists and what it contains
  if (envPathToLoad && existsSync(envPathToLoad)) {
    try {
      const content = readFileSync(envPathToLoad, 'utf-8');
      const hasOpenAIKey = /^OPENAI_API_KEY\s*=/m.test(content);
      writeDiag(`.env file exists and ${hasOpenAIKey ? 'CONTAINS' : 'DOES NOT CONTAIN'} OPENAI_API_KEY line`);
      if (hasOpenAIKey) {
        const match = content.match(/^OPENAI_API_KEY\s*=\s*(.*)$/m);
        if (match) {
          const value = match[1].trim();
          writeDiag(`OPENAI_API_KEY value in file: ${value ? `EXISTS (length: ${value.length}, starts with: ${value.substring(0, 10)}...)` : 'EMPTY'}`);
        }
      }
    } catch (e) {
      writeDiag(`Could not read .env file for diagnostics: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
} else if (envData.OPENAI_API_KEY) {
  writeDiag(`✓ OPENAI_API_KEY successfully parsed into envData (length: ${envData.OPENAI_API_KEY.length})`);
}

writeDiag('ENV.TS MODULE COMPLETE');
process.stderr.write('=== ENV.TS COMPLETE ===\n\n');

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
