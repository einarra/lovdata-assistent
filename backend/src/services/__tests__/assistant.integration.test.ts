import { describe, it, expect, beforeEach, vi } from 'vitest';

const orchestratorMock = vi.hoisted(() => ({
  run: vi.fn()
}));

const agentMocks = vi.hoisted(() => ({
  agent: {
    generate: vi.fn()
  },
  enabled: true
}));

const serviceMocks = vi.hoisted(() => ({
  lovdata: {
    extractXml: vi.fn()
  },
  archive: {
    search: vi.fn(),
    getDocument: vi.fn(),
    readDocumentText: vi.fn()
  },
  serper: undefined
}));

vi.mock('../../agents/index.js', () => {
  return {
    getAgent: () => (agentMocks.enabled ? agentMocks.agent : null)
  };
});

vi.mock('../../skills/index.js', () => {
  return {
    getOrchestrator: async () => orchestratorMock
  };
});

vi.mock('../index.js', () => {
  return {
    getServices: () => serviceMocks
  };
});

const { runAssistant } = await import('../assistant.js');

describe('runAssistant integration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    agentMocks.enabled = true;
  });

  it('uses agent response when available', async () => {
    const hits = [
      {
        filename: 'archive.tar.bz2',
        member: 'doc.xml',
        title: 'Title',
        date: '2024-01-01',
        snippet: 'Snippet'
      }
    ];

    orchestratorMock.run.mockResolvedValueOnce({
      result: {
        hits,
        totalHits: 1,
        page: 1,
        pageSize: 1
      }
    });

    serviceMocks.archive.search.mockReturnValue({
      hits,
      total: 1,
      searchedFiles: ['archive.tar.bz2']
    });

    serviceMocks.archive.getDocument.mockReturnValue({
      content: '<xml></xml>',
      title: 'Title',
      date: '2024-01-01',
      relativePath: null
    });
    serviceMocks.archive.readDocumentText.mockResolvedValue('<xml></xml>');

    agentMocks.agent.generate.mockResolvedValue({
      answer: 'Agent answer',
      citations: [],
      model: 'test-model'
    });

    const response = await runAssistant({ question: 'Hva er rettspraksis?' });

    expect(response.answer).toBe('Agent answer');
    expect(response.metadata.usedAgent).toBe(true);
    expect(orchestratorMock.run).toHaveBeenCalled();
  });

  it('falls back to heuristic summary when agent unavailable', async () => {
    agentMocks.enabled = false;

    orchestratorMock.run.mockResolvedValueOnce({
      result: {
        hits: [],
        totalHits: 0,
        page: 1,
        pageSize: 5,
        fallback: {
          provider: 'serper',
          organic: [
            {
              title: 'Fallback',
              link: 'https://example.com',
              snippet: 'Example snippet',
              date: null
            }
          ]
        }
      }
    });

    const response = await runAssistant({ question: 'Hva sier loven?' });

    expect(response.metadata.usedAgent).toBe(false);
    expect(response.answer).toContain('Her er en oppsummering');
  });
});

