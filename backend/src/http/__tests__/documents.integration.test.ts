import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const serviceMocks = vi.hoisted(() => {
  const archive = {
    getDocument: vi.fn(),
    readDocumentText: vi.fn()
  };
  const lovdata = {
    extractXml: vi.fn()
  };
  return { archive, lovdata };
});

vi.mock('../../services/index.js', () => {
  return {
    getServices: () => ({
      lovdata: serviceMocks.lovdata,
      archive: serviceMocks.archive,
      serper: undefined
    })
  };
});

const { createApp } = await import('../app.js');

describe('GET /documents/xml', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('serves archived HTML documents with stylesheet', async () => {
    const html = '<html><head></head><body><h1>Test</h1></body></html>';
    serviceMocks.archive.getDocument.mockReturnValue({
      title: 'Test Title',
      date: '2024-01-01',
      content: html,
      relativePath: null
    });
    serviceMocks.archive.readDocumentText.mockResolvedValue(html);

    const app = createApp();
    const response = await request(app)
      .get('/documents/xml')
      .query({ filename: 'archive.tar.bz2', member: 'doc.xml' })
      .expect(200);

    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('<link rel="stylesheet" type="text/css" href="/documents/styles/archive.css" />');
    expect(serviceMocks.lovdata.extractXml).not.toHaveBeenCalled();
  });

  it('falls back to Lovdata extract when archive is missing', async () => {
    serviceMocks.archive.getDocument.mockReturnValue(null);
    serviceMocks.lovdata.extractXml.mockResolvedValue({
      text: '<root>Example</root>',
      title: 'Example',
      date: '2024-01-01'
    });

    const app = createApp();
    const response = await request(app)
      .get('/documents/xml')
      .query({ filename: 'archive.tar.bz2', member: 'doc.xml' })
      .expect(200);

    expect(response.headers['content-type']).toContain('application/xml');
    expect(response.text).toContain('<root>Example</root>');
    expect(serviceMocks.lovdata.extractXml).toHaveBeenCalledWith('archive.tar.bz2', 'doc.xml');
  });
});

