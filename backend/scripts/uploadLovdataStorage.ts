import 'dotenv/config';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

type UploadOptions = {
  supabaseUrl: string;
  serviceRoleKey: string;
  archivesDir: string;
  documentsDir: string;
  archivesBucket: string;
  documentsBucket: string;
  dryRun: boolean;
  throttleMs: number;
};

type UploadResult = {
  uploaded: number;
  skipped: number;
  failed: string[];
};

function parseArgs(): UploadOptions {
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment. Aborting.');
    process.exit(1);
  }

  const cwd = process.cwd();
  const defaults: UploadOptions = {
    supabaseUrl,
    serviceRoleKey,
    archivesDir: path.resolve(cwd, 'data', 'archives'),
    documentsDir: path.resolve(cwd, 'data', 'archives'),
    archivesBucket: process.env.LOVDATA_ARCHIVES_BUCKET ?? 'lovdata-archives',
    documentsBucket: process.env.LOVDATA_DOCUMENTS_BUCKET ?? 'lovdata-documents',
    dryRun: false,
    throttleMs: Number.parseInt(process.env.LOVDATA_UPLOAD_THROTTLE_MS ?? '50', 10)
  };

  const args = process.argv.slice(2);
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];
    switch (arg) {
      case '--archives-dir': {
        const value = args[idx + 1];
        if (!value) throw new Error(`${arg} requires a value`);
        defaults.archivesDir = path.resolve(cwd, value);
        idx += 1;
        break;
      }
      case '--documents-dir': {
        const value = args[idx + 1];
        if (!value) throw new Error(`${arg} requires a value`);
        defaults.documentsDir = path.resolve(cwd, value);
        idx += 1;
        break;
      }
      case '--archives-bucket': {
        const value = args[idx + 1];
        if (!value) throw new Error(`${arg} requires a value`);
        defaults.archivesBucket = value;
        idx += 1;
        break;
      }
      case '--documents-bucket': {
        const value = args[idx + 1];
        if (!value) throw new Error(`${arg} requires a value`);
        defaults.documentsBucket = value;
        idx += 1;
        break;
      }
      case '--dry-run': {
        defaults.dryRun = true;
        break;
      }
      case '--throttle': {
        const value = args[idx + 1];
        if (!value) throw new Error(`${arg} requires a value`);
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`Invalid throttle value: ${value}`);
        }
        defaults.throttleMs = parsed;
        idx += 1;
        break;
      }
      case '--help':
      case '-h': {
        printUsage();
        process.exit(0);
      }
      default: {
        console.warn(`Unknown argument "${arg}" – run with --help for usage.`);
      }
    }
  }

  return defaults;
}

function printUsage(): void {
  console.log('Upload Lovdata archives and normalized documents to Supabase Storage.');
  console.log('Usage: npm run upload-lovdata-storage -- [--archives-dir <path>] [--documents-dir <path>] [--dry-run]');
  console.log('Environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required).');
  console.log('Optional: LOVDATA_ARCHIVES_BUCKET (default: lovdata-archives), LOVDATA_DOCUMENTS_BUCKET (default: lovdata-documents).');
  console.log('          LOVDATA_UPLOAD_THROTTLE_MS (default 50) or --throttle to control delay between uploads.');
}

async function computeSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function uploadFile(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  storagePath: string,
  filePath: string,
  dryRun: boolean
): Promise<boolean> {
  if (dryRun) {
    console.log(`[upload] (dry-run) Would upload ${filePath} -> ${bucket}/${storagePath}`);
    return true;
  }

  const data = await fs.readFile(filePath);
  const maxAttempts = 5;
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    const { error } = await supabase.storage.from(bucket).upload(storagePath, data, {
      upsert: true,
      contentType: storagePath.endsWith('.xml') ? 'application/xml' : 'application/octet-stream',
      cacheControl: '3600'
    });
    if (!error) {
      return true;
    }
    const isLast = attempt === maxAttempts;
    const delayMs = 500 * attempt;
    console.warn(
      `[upload] Attempt ${attempt} failed for ${filePath} (status=${(error as any)?.statusCode ?? 'unknown'} message=${error.message}).${
        isLast ? '' : ` Retrying in ${delayMs}ms`
      }`
    );
    if (isLast) {
      throw new Error(`Failed to upload ${filePath} to ${bucket}/${storagePath}: ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return true;
}

async function uploadDirectory(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  sourceDir: string,
  prefix: string,
  dryRun: boolean,
  throttleMs: number,
  failures: string[]
): Promise<UploadResult> {
  let uploaded = 0;
  let skipped = 0;

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(sourceDir, entry.name);
    if (entry.isDirectory()) {
      const nestedPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      const nestedResult = await uploadDirectory(
        supabase,
        bucket,
        absolutePath,
        nestedPrefix,
        dryRun,
        throttleMs,
        failures
      );
      uploaded += nestedResult.uploaded;
      skipped += nestedResult.skipped;
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const storagePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    try {
      await uploadFile(supabase, bucket, storagePath, absolutePath, dryRun);
      uploaded += 1;
      if (!dryRun && throttleMs > 0) {
        await new Promise(resolve => setTimeout(resolve, throttleMs));
      }
    } catch (error) {
      failures.push(`${bucket}/${storagePath} :: ${(error as Error).message}`);
    }
  }

  return { uploaded, skipped, failed: failures };
}

async function uploadArchives(
  supabase: ReturnType<typeof createClient>,
  options: UploadOptions
): Promise<void> {
  try {
    await fs.access(options.archivesDir);
  } catch {
    console.warn(`[upload] Archives directory not found at ${options.archivesDir} – skipping`);
    return;
  }

  const failures: string[] = [];
  const result = await uploadDirectory(
    supabase,
    options.archivesBucket,
    options.archivesDir,
    '',
    options.dryRun,
    options.throttleMs,
    failures
  );
  console.log(
    `[upload] Archives upload complete (bucket=${options.archivesBucket}, uploaded=${result.uploaded}, skipped=${result.skipped}, failed=${failures.length})`
  );
  if (failures.length > 0) {
    await writeFailureLog('archives', failures);
  }
}

async function uploadDocuments(
  supabase: ReturnType<typeof createClient>,
  options: UploadOptions
): Promise<void> {
  try {
    await fs.access(options.documentsDir);
  } catch {
    console.warn(`[upload] Documents directory not found at ${options.documentsDir} – skipping`);
    return;
  }

  const failures: string[] = [];
  const result = await uploadDirectory(
    supabase,
    options.documentsBucket,
    options.documentsDir,
    '',
    options.dryRun,
    options.throttleMs,
    failures
  );
  console.log(
    `[upload] Documents upload complete (bucket=${options.documentsBucket}, uploaded=${result.uploaded}, skipped=${result.skipped}, failed=${failures.length})`
  );
  if (failures.length > 0) {
    await writeFailureLog('documents', failures);
  }
}

async function writeFailureLog(kind: 'archives' | 'documents', failures: string[]): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.resolve(process.cwd(), `tmp/upload-failures-${kind}-${timestamp}.log`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, failures.join('\n'), 'utf-8');
  console.warn(`[upload] Wrote ${failures.length} ${kind} failures to ${filePath}`);
}

async function main() {
  const options = parseArgs();
  console.log('[upload] Starting Lovdata storage upload with options:', {
    ...options,
    serviceRoleKey: '<hidden>'
  });

  const supabase = createClient(options.supabaseUrl, options.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  try {
    await uploadArchives(supabase, options);
    await uploadDocuments(supabase, options);
    console.log('[upload] Upload completed successfully.');
  } catch (error) {
    console.error('[upload] Upload failed:', error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('[upload] Uncaught failure:', error);
  process.exit(1);
});


