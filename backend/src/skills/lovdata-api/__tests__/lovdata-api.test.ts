import { describe, expect, it, vi, beforeEach } from 'vitest';
import { __test__ } from '../index.js';
import { execute } from '../index.js';

const stubStore = {
  search: vi.fn()
};

const stubLovdataClient = {
  listPublicData: vi.fn(),
  getJson: vi.fn()
};

const stubSerperClient = {
  search: vi.fn()
};

describe('Lovdata skill normalizeInput', () => {
  it('infers list action from plain text', () => {
    const command = __test__.normalizeInput('Please list Lovdata datasets');
    expect(command).toEqual({ action: 'listPublicData' });
  });

  it('supports explicit fetchJson action', () => {
    const command = __test__.normalizeInput({ action: 'fetchJson', path: '/v1/publicData/list' });
    expect(command).toEqual({ action: 'fetchJson', path: '/v1/publicData/list' });
  });

  it('defaults to search for free-form questions', () => {
    const command = __test__.normalizeInput('Hva sier arbeidsmiljøloven om arbeidstid?');
    expect(command).toEqual({ action: 'searchPublicData', query: 'Hva sier arbeidsmiljøloven om arbeidstid?' });
  });

  it('keeps pagination parameters when provided', () => {
    const command = __test__.normalizeInput({
      action: 'searchPublicData',
      query: 'arbeidstid',
      page: 2,
      pageSize: 15
    });
    expect(command).toEqual({
      action: 'searchPublicData',
      query: 'arbeidstid',
      page: 2,
      pageSize: 15
    });
  });

  it('rejects unsupported structures', () => {
    expect(() => __test__.normalizeInput({})).toThrow();
  });
});

describe('Lovdata skill execute integration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('uses Serper fallback when archive returns no hits', async () => {
    stubStore.search.mockReturnValue({
      hits: [],
      total: 0,
      searchedFiles: []
    });

    stubSerperClient.search.mockResolvedValue({
      organic: [
        {
          title: 'Fallback result',
          link: 'https://example.com',
          snippet: 'Example snippet',
          date: '2024-01-01'
        }
      ],
      site: 'lovdata.no'
    });

    const result = await execute(
      { input: { action: 'searchPublicData', query: 'tingsrett' } },
      {
        services: {
          lovdata: stubLovdataClient as any,
          archive: stubStore as any,
          serper: stubSerperClient as any
        }
      } as any
    );

    const output = result.result as any;
    expect(output.fallback?.provider).toContain('serper');
    expect(output.fallback?.organic?.length).toBe(1);
    expect(stubSerperClient.search).toHaveBeenCalledWith('tingsrett', { num: 10 });
  });
});
