// Embedded skill manifests to ensure they're always available
// This avoids issues with file system access in serverless environments

import type { Manifest } from './skills-loader.js';

export const LOVDATA_API_MANIFEST: Manifest = {
  name: 'lovdata-api',
  version: '1.0.0',
  summary: 'Query structured legal data directly from Lovdata\'s official API.',
  description: 'Provides read-only access to Lovdata\'s public endpoints for listing datasets and fetching JSON legal metadata.',
  tags: ['lovdata', 'legal', 'api'],
  matchers: [
    { includes: ['lovdata'], weight: 0.96 },
    { includes: ['legal', 'dataset'], weight: 0.92 },
    { includes: ['statute'], weight: 0.65 },
    { includes: [], weight: 0.7 }
  ],
  module: 'index'
};

export const LOVDATA_SERPER_MANIFEST: Manifest = {
  name: 'lovdata-serper',
  version: '1.0.0',
  summary: 'Perform targeted web searches on Lovdata.no via Serper.',
  description: 'Uses the Serper API to browse Lovdata.no, returning curated organic results and snippets.',
  tags: ['lovdata', 'search', 'serper'],
  matchers: [
    { includes: ['search', 'lovdata'], weight: 0.95 },
    { includes: ['browse', 'lovdata'], weight: 0.9 },
    { includes: ['serper'], weight: 0.85 },
    { includes: [], weight: 0.55 }
  ],
  module: 'index'
};

export const SKILL_MANIFESTS: Record<string, Manifest> = {
  'lovdata-api': LOVDATA_API_MANIFEST,
  'lovdata-serper': LOVDATA_SERPER_MANIFEST
};

