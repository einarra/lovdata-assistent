import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { getOrchestrator } from '../skills/index.js';
import { getServices } from '../services/index.js';
import { logger } from '../logger.js';
import { runAssistant } from '../services/assistant.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register as metricsRegistry } from '../observability/metrics.js';
import { isReady } from '../state/runtimeState.js';
import { requireSupabaseAuth, type AuthenticatedRequest } from './middleware/requireSupabaseAuth.js';
import { getSupabaseAdminClient } from '../services/supabaseClient.js';
import { Timer, timeOperation } from '../utils/timing.js';

const runSchema = z.object({
  input: z.unknown(),
  hints: z.record(z.unknown()).optional(),
  context: z
    .object({
      userId: z.string().optional(),
      locale: z.string().optional()
    })
    .optional()
});

const assistantSchema = z.object({
  question: z.string().min(3, 'question must be at least 3 characters'),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(20).optional(),
  locale: z.string().optional()
});

const readXmlSchema = z.object({
  filename: z.coerce.string().min(1, 'filename is required'),
  member: z.coerce.string().min(1, 'member is required')
});

export function createApp() {
  const app = express();
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const assetsDir = path.join(currentDir, '..', '..', 'public');
  
  // Log registered routes for debugging (in serverless environments)
  if (process.env.VERCEL || process.cwd().startsWith('/var/task')) {
    // Log routes after they're registered (we'll add this after route registration)
    process.nextTick(() => {
      const routes: string[] = [];
      app._router?.stack?.forEach((middleware: any) => {
        if (middleware.route) {
          const methods = Object.keys(middleware.route.methods).join(',').toUpperCase();
          routes.push(`${methods} ${middleware.route.path}`);
        }
      });
      logger.info({ routes }, 'Registered Express routes');
    });
  }

  app.use(
    cors({
      origin: true
    })
  );
  app.use(express.json({ limit: '1mb' }));
  app.use('/documents/styles', express.static(assetsDir));

  app.get('/health', (_req: Request, res: Response) => {
    const services = getServices();
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      ready: isReady(),
      archiveIndexed: Boolean(services.archive)
    });
  });

  app.get('/ready', (_req: Request, res: Response) => {
    const services = getServices();
    if (!isReady() || !services.archive) {
      res.status(503).json({
        status: 'not_ready',
        archiveIndexed: Boolean(services.archive)
      });
      return;
    }
    res.json({
      status: 'ready',
      archiveIndexed: true
    });
  });

  app.get('/metrics', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader('Content-Type', metricsRegistry.contentType);
      res.send(await metricsRegistry.metrics());
    } catch (error) {
      next(error);
    }
  });

  app.post('/skills/run', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const output = await timeOperation(
        'skills_run',
        async () => {
          const orchestrator = await getOrchestrator();
          const payload = runSchema.parse(req.body ?? {});

          const ctx = {
            ...(payload.context ?? {}),
            now: new Date(),
            services: getServices(),
            scratch: {}
          } as const;

          return await orchestrator.run(
            { input: payload.input, hints: payload.hints },
            ctx
          );
        },
        logger,
        { endpoint: '/skills/run' }
      );
      res.json(output);
    } catch (error) {
      next(error);
    }
  });

  app.post('/assistant/run', requireSupabaseAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Log request details for debugging
      logger.info({
        path: req.path,
        method: req.method,
        hasBody: !!req.body,
        bodyType: typeof req.body,
        bodyKeys: req.body ? Object.keys(req.body) : [],
        contentType: req.headers['content-type']
      }, 'Assistant run: request received');
      
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.auth?.userId;
      
      if (!userId) {
        logger.warn({ path: req.path }, 'Assistant run: userId missing after auth');
        res.status(401).json({ message: 'User ID not found in authentication' });
        return;
      }
      
      // Parse and validate payload
      let payload;
      try {
        payload = assistantSchema.parse(req.body ?? {});
        logger.info({
          questionLength: payload.question.length,
          hasPage: !!payload.page,
          hasPageSize: !!payload.pageSize,
          locale: payload.locale
        }, 'Assistant run: payload validated');
      } catch (parseError) {
        logger.error({ err: parseError, body: req.body }, 'Assistant run: payload validation failed');
        throw parseError;
      }
      
      // Execute assistant run
      const output = await timeOperation(
        'assistant_run',
        () => runAssistant(payload, userId ? { userId } : undefined),
        logger,
        { endpoint: '/assistant/run', userId, questionLength: payload.question.length }
      );
      
      logger.info({
        answerLength: output.answer.length,
        evidenceCount: output.evidence.length,
        usedAgent: output.metadata.usedAgent
      }, 'Assistant run: completed successfully');
      
      res.json(output);
    } catch (error) {
      logger.error({ 
        err: error,
        path: req.path,
        method: req.method,
        hasBody: !!req.body,
        bodyType: typeof req.body
      }, 'Assistant run: error occurred');
      next(error);
    }
  });

  // Handle GET requests to POST-only routes with a helpful error
  app.get('/assistant/run', (_req: Request, res: Response) => {
    res.status(405).json({
      error: 'Method Not Allowed',
      message: 'This endpoint only accepts POST requests',
      hint: 'The request was sent as GET instead of POST. Check that the frontend is using method: "POST" in the fetch call.'
    });
  });

  app.get('/session', requireSupabaseAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.auth?.userId;

      if (!userId) {
        res.status(401).json({ message: 'Unauthorized' });
        return;
      }

      const supabase = getSupabaseAdminClient();
      const { data, error } = await supabase.auth.admin.getUserById(userId);
      if (error || !data?.user) {
        res.status(401).json({ message: error?.message ?? 'User not found' });
        return;
      }

      const user = data.user;
      res.json({
        user: {
          id: user.id,
          email: user.email,
          createdAt: user.created_at,
          appMetadata: user.app_metadata ?? {},
          userMetadata: user.user_metadata ?? {}
        },
        subscription: {
          status: 'free',
          plan: 'Supabase',
          lastSyncedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/documents/xml', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { filename, member } = readXmlSchema.parse(req.query);
      const format =
        typeof req.query.format === 'string'
          ? (req.query.format as string).toLowerCase()
          : Array.isArray(req.query.format)
          ? (req.query.format[0] as string)?.toLowerCase()
          : undefined;
      
      const output = await timeOperation(
        'get_document_xml',
        async () => {
          const services = getServices();
          const archiveStore = services.archive ?? null;

          let text: string | null = null;
          let title: string | null = null;
          let date: string | null = null;

          // If member ends in .html, fall back to .xml for fetching
          // This allows links to show .html extension while still fetching the actual .xml file
          let actualMember = member;
          if (member.toLowerCase().endsWith('.html')) {
            const xmlMember = member.replace(/\.html$/i, '.xml');
            // Try .xml version first since that's what's actually in the archive
            if (archiveStore) {
              const recordTimer = new Timer('get_document_record', logger, { filename, member: xmlMember });
              const record = await archiveStore.getDocumentAsync(filename, xmlMember);
              recordTimer.end({ found: !!record });
              if (record) {
                actualMember = xmlMember;
              }
            } else if (services.lovdata) {
              // If no archive store, try to verify .xml exists via lovdata API
              try {
                await services.lovdata.extractXml(filename, xmlMember);
                actualMember = xmlMember;
              } catch {
                // Keep .html if .xml doesn't exist (unlikely but handle gracefully)
              }
            }
          }

          if (archiveStore) {
            const recordTimer = new Timer('get_document_record', logger, { filename, member: actualMember });
            const record = await archiveStore.getDocumentAsync(filename, actualMember);
            recordTimer.end({ found: !!record });
            
            if (record) {
              const textTimer = new Timer('read_document_text', logger, { filename, member: actualMember });
              text = await archiveStore.readDocumentText(filename, actualMember);
              textTimer.end({ textLength: text?.length ?? 0 });
              title = record.title;
              date = record.date;
            }
          }

          if (!text) {
            try {
              const remoteTimer = new Timer('fetch_remote_xml', logger, { filename, member: actualMember });
              const remote = await services.lovdata.extractXml(filename, actualMember);
              remoteTimer.end({ textLength: remote.text?.length ?? 0 });
              text = remote.text;
              title = remote.title ?? null;
              date = remote.date ?? null;
            } catch (error) {
              throw error;
            }
          }

          return { text, title, date, format };
        },
        logger,
        { endpoint: '/documents/xml', filename, member, format }
      );

      const { text, title, date } = output;

      if (!text) {
        res.status(204).send();
        return;
      }

      const markdown = formatLovdataMarkdown(text, { title, date });
      const isHtml = isHtmlContent(text);

      if (title) {
        res.setHeader('X-Lovdata-Title', title);
      }
      if (date) {
        res.setHeader('X-Lovdata-Date', date);
      }

      if (format === 'markdown') {
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.send(markdown);
        return;
      }

      if (format === 'json') {
        res.json({
          title,
          date,
          text,
          markdown
        });
        return;
      }

      const isXml = member.toLowerCase().endsWith('.xml');
      const stylesheetHref = '/documents/styles/archive.css';
      if (isHtml) {
        const styledHtml = injectHtmlStylesheet(text, stylesheetHref);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(styledHtml);
        return;
      }

      if (isXml) {
        const styledXml = attachStylesheet(text, stylesheetHref);
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.send(styledXml);
        return;
      }

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(text);
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: error }, 'Unhandled error');
    if (error instanceof z.ZodError) {
      res.status(400).json({ message: 'Invalid request payload', issues: error.issues });
      return;
    }
    const status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as any).status) : 500;
    const message = typeof error === 'object' && error !== null && 'message' in error ? (error as any).message : 'Internal Server Error';
    res.status(Number.isNaN(status) ? 500 : status).json({ message });
  });

  return app;
}

function formatLovdataMarkdown(
  text: string,
  metadata: { title?: string | null; date?: string | null }
): string {
  const normalised = text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lower = normalised.toLowerCase();
  let metadataPart = normalised;
  let contentPart = '';

  const innholdIdx = lower.indexOf('\ninnhold');
  if (innholdIdx >= 0) {
    metadataPart = normalised.slice(0, innholdIdx);
    contentPart = normalised.slice(innholdIdx);
  } else {
    const plainIdx = lower.indexOf(' innhold ');
    if (plainIdx >= 0) {
      metadataPart = normalised.slice(0, plainIdx);
      contentPart = normalised.slice(plainIdx);
    }
  }

  metadataPart = metadataPart.replace(/^[.\s-]+/, '').trim();

  const labels = [
    'Datokode',
    'DokumentID',
    'Departement',
    'Publisert',
    'I kraft fra',
    'Endrer',
    'Kunngjort',
    'Journalnummer',
    'Korttittel',
    'Tittel',
    'Annet om dokumentet',
    'RefID'
  ];

  const labelRegex = new RegExp(`\\b(${labels.map(escapeRegex).join('|')})\\b`, 'gi');
  const occurrences: Array<{ label: string; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = labelRegex.exec(metadataPart)) !== null) {
    occurrences.push({ label: match[1], index: match.index });
  }

  const metadataLines: string[] = [];
  if (occurrences.length > 0) {
    occurrences.forEach((item, idx) => {
      const start = item.index + item.label.length;
      const end = idx + 1 < occurrences.length ? occurrences[idx + 1].index : metadataPart.length;
      const rawValue = metadataPart.slice(start, end).replace(/^[\s:.-]+/, '').trim();
      const value = rawValue.replace(/\s{2,}/g, ' ');
      metadataLines.push(`- **${item.label}:** ${value}`);
    });
  }

  const leftoverMeta = metadataPart.replace(labelRegex, '').trim();
  if (leftoverMeta) {
    metadataLines.push(leftoverMeta);
  }

  const metadataMarkdown = metadataLines
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .join('\n');

  if (!contentPart) {
    contentPart = normalised;
  }

  let body = contentPart.trim();
  body = body.replace(/^Innhold\s*/i, '## Innhold\n\n');

  body = body.replace(
    /\b([IVX]{1,4})(?:\.)?\b\s+(?=[A-ZÆØÅ])/g,
    (_match, numeral: string) => `\n\n### ${numeral.replace(/\.$/, '')}\n`
  );

  body = body.replace(
    /§\s*(\d+[a-z]?(?:-\d+)?)/gi,
    (_match, paragraph: string) => `\n\n#### § ${paragraph.toUpperCase()}\n`
  );

  body = body.replace(/([.!?])\s+(?=[A-ZÆØÅ])/g, '$1\n\n');
  body = body.replace(/(\n|^)([A-ZÆØÅ].*?:)\s+(?=[A-ZÆØÅ])/gm, '$1$2\n');

  body = body.replace(/([a-zæøå])\)\s+/gi, '$1) ');
  body = body.replace(/([0-9]+)\.\s+(?=[A-ZÆØÅ])/g, '\n- ');

  body = body.replace(/\n +/g, '\n');
  body = body.replace(/\n{3,}/g, '\n\n').trim();

  if (metadata.title) {
    const titlePattern = new RegExp(`^${escapeRegex(metadata.title)}[\\s.]*`, 'i');
    body = body.replace(titlePattern, '').trim();
  }

  body = body.replace(/## Innhold\s*\n\n([^#]+?)(\n\n###|\n####|$)/s, (_match, listBlock: string, tail: string) => {
    const items = listBlock
      .replace(/\s+/g, ' ')
      .trim()
      .split(/\s+(?=[IVX]{1,4}(?:\.|\b))/)
      .map(entry => entry.trim())
      .filter(Boolean)
      .map(entry => `- ${entry.replace(/[.:]$/, '')}`);
    const formatted = items.length > 0 ? `## Innhold\n\n${items.join('\n')}` : '## Innhold';
    return `${formatted}${tail}`;
  });

  const innholdPosition = body.indexOf('## Innhold');
  if (innholdPosition > 0) {
    body = body.slice(innholdPosition).trimStart();
  }

  const segments: string[] = [];
  if (metadata.title) {
    segments.push(`# ${metadata.title}`);
  }
  if (metadata.date) {
    segments.push(`*Dato:* ${metadata.date}`);
  }
  const formattedMetadata = metadataMarkdown.trim();
  if (formattedMetadata) {
    segments.push(formattedMetadata);
  }
  if (body) {
    segments.push(body);
  }

  return segments.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function attachStylesheet(xml: string, href: string): string {
  if (!xml || xml.includes('<?xml-stylesheet')) {
    return xml;
  }
  const instruction = `<?xml-stylesheet type="text/css" href="${href}"?>\n`;
  const match = xml.match(/^<\?xml[^>]*\?>\s*/);
  if (match) {
    const declaration = match[0];
    return `${declaration}${instruction}${xml.slice(declaration.length)}`;
  }
  return `${instruction}${xml}`;
}

function isHtmlContent(text: string): boolean {
  if (!text) {
    return false;
  }
  const snippet = text.slice(0, 1000).toLowerCase();
  return snippet.includes('<html') || snippet.includes('<!doctype html');
}

function injectHtmlStylesheet(html: string, href: string): string {
  if (!html) {
    return html;
  }
  const linkTag = `<link rel="stylesheet" type="text/css" href="${href}" />`;
  if (html.includes(linkTag)) {
    return html;
  }
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    const insertPos = headMatch.index! + headMatch[0].length;
    return `${html.slice(0, insertPos)}\n  ${linkTag}\n${html.slice(insertPos)}`;
  }
  if (html.includes('<html')) {
    return html.replace(/<html[^>]*>/i, match => `${match}\n<head>\n  ${linkTag}\n</head>\n`);
  }
  return `${linkTag}\n${html}`;
}
