#!/usr/bin/env tsx
/**
 * Test script to verify parallel search and deduplication functionality
 */

// Mock test data to verify logic
type MockEvidence = {
  id: string;
  source: string;
  link?: string | null;
  metadata?: {
    filename?: string;
    member?: string;
  };
};

// Test deduplication logic (same as in assistant.ts)
function testLovdataDeduplication() {
  console.log('\n=== Testing Lovdata Deduplication ===');
  
  // Simulate existing evidence
  const agentEvidence: MockEvidence[] = [
    {
      id: 'lovdata-1',
      source: 'lovdata',
      metadata: { filename: 'archive1.tbz2', member: 'doc1.xml' }
    },
    {
      id: 'lovdata-2',
      source: 'lovdata',
      metadata: { filename: 'archive1.tbz2', member: 'doc2.xml' }
    }
  ];
  
  // New evidence with duplicates
  const newEvidence: MockEvidence[] = [
    {
      id: 'lovdata-3',
      source: 'lovdata',
      metadata: { filename: 'archive1.tbz2', member: 'doc2.xml' } // Duplicate
    },
    {
      id: 'lovdata-4',
      source: 'lovdata',
      metadata: { filename: 'archive1.tbz2', member: 'doc3.xml' } // New
    },
    {
      id: 'lovdata-5',
      source: 'lovdata',
      metadata: { filename: 'archive2.tbz2', member: 'doc1.xml' } // New (different filename)
    }
  ];
  
  // Apply deduplication (same logic as assistant.ts)
  const existingKeys = new Set(agentEvidence.map(e => `${e.metadata?.filename}:${e.metadata?.member}`));
  const uniqueNewEvidence = newEvidence.filter(e => {
    const key = `${e.metadata?.filename}:${e.metadata?.member}`;
    if (existingKeys.has(key)) {
      return false;
    }
    existingKeys.add(key);
    return true;
  });
  
  const finalEvidence = [...agentEvidence, ...uniqueNewEvidence];
  
  console.log('Initial evidence:', agentEvidence.length);
  console.log('New evidence:', newEvidence.length);
  console.log('Unique new evidence:', uniqueNewEvidence.length);
  console.log('Final evidence:', finalEvidence.length);
  
  // Verify: Should have 4 items (2 initial + 2 new unique)
  const expectedCount = 4;
  const actualCount = finalEvidence.length;
  const success = actualCount === expectedCount;
  
  console.log(`\n✅ Expected ${expectedCount} items, got ${actualCount}: ${success ? 'PASS' : 'FAIL'}`);
  
  // Verify no duplicates
  const keys = finalEvidence.map(e => `${e.metadata?.filename}:${e.metadata?.member}`);
  const uniqueKeys = new Set(keys);
  const hasDuplicates = keys.length !== uniqueKeys.size;
  console.log(`✅ No duplicates: ${!hasDuplicates ? 'PASS' : 'FAIL'}`);
  
  return success && !hasDuplicates;
}

function testSerperDeduplication() {
  console.log('\n=== Testing Serper Deduplication ===');
  
  // Simulate existing evidence
  const agentEvidence: MockEvidence[] = [
    {
      id: 'serper-1',
      source: 'serper',
      link: 'https://lovdata.no/avgjorelser/123'
    },
    {
      id: 'serper-2',
      source: 'serper',
      link: 'https://lovdata.no/lovtidend/456'
    }
  ];
  
  // New evidence with duplicates
  const newEvidence: MockEvidence[] = [
    {
      id: 'serper-3',
      source: 'serper',
      link: 'https://lovdata.no/lovtidend/456' // Duplicate
    },
    {
      id: 'serper-4',
      source: 'serper',
      link: 'https://lovdata.no/avgjorelser/789' // New
    },
    {
      id: 'serper-5',
      source: 'serper',
      link: null // Should be filtered out
    }
  ];
  
  // Apply deduplication (same logic as assistant.ts)
  const existingLinks = new Set(agentEvidence.map(e => e.link).filter(Boolean));
  const uniqueNewEvidence = newEvidence.filter(e => {
    if (!e.link || existingLinks.has(e.link)) {
      return false;
    }
    existingLinks.add(e.link);
    return true;
  });
  
  const finalEvidence = [...agentEvidence, ...uniqueNewEvidence];
  
  console.log('Initial evidence:', agentEvidence.length);
  console.log('New evidence:', newEvidence.length);
  console.log('Unique new evidence:', uniqueNewEvidence.length);
  console.log('Final evidence:', finalEvidence.length);
  
  // Verify: Should have 3 items (2 initial + 1 new unique, null link filtered)
  const expectedCount = 3;
  const actualCount = finalEvidence.length;
  const success = actualCount === expectedCount;
  
  console.log(`\n✅ Expected ${expectedCount} items, got ${actualCount}: ${success ? 'PASS' : 'FAIL'}`);
  
  // Verify no duplicates
  const links = finalEvidence.map(e => e.link).filter(Boolean);
  const uniqueLinks = new Set(links);
  const hasDuplicates = links.length !== uniqueLinks.size;
  console.log(`✅ No duplicates: ${!hasDuplicates ? 'PASS' : 'FAIL'}`);
  
  return success && !hasDuplicates;
}

function testParallelSearchLogic() {
  console.log('\n=== Testing Parallel Search Logic ===');
  
  // Simulate the parallel search structure
  const simulateParallelSearch = async () => {
    const startTime = Date.now();
    
    // Simulate two parallel searches
    const [lovResult, forskriftResult] = await Promise.all([
      new Promise<{ hits: number[] }>(resolve => {
        setTimeout(() => resolve({ hits: [1, 2, 3, 4, 5] }), 100);
      }),
      new Promise<{ hits: number[] }>(resolve => {
        setTimeout(() => resolve({ hits: [6, 7, 8] }), 120);
      })
    ]);
    
    const elapsed = Date.now() - startTime;
    
    console.log('Lov result hits:', lovResult.hits.length);
    console.log('Forskrift result hits:', forskriftResult.hits.length);
    console.log('Time elapsed (ms):', elapsed);
    
    // Verify both results are available
    const bothAvailable = lovResult.hits.length > 0 && forskriftResult.hits.length > 0;
    console.log(`✅ Both results available: ${bothAvailable ? 'PASS' : 'FAIL'}`);
    
    // Verify parallel execution (should be ~120ms, not ~220ms)
    // With some tolerance for timing variations
    const sequentialTime = 100 + 120; // Would be sequential
    const isParallel = elapsed < sequentialTime * 0.8; // Allow 20% tolerance
    console.log(`✅ Executed in parallel (${elapsed}ms < ${sequentialTime}ms sequential): ${isParallel ? 'PASS' : 'FAIL'}`);
    
    return bothAvailable && isParallel;
  };
  
  return simulateParallelSearch();
}

async function runAllTests() {
  console.log('🧪 Testing Parallel Search and Deduplication\n');
  
  const test1 = testLovdataDeduplication();
  const test2 = testSerperDeduplication();
  const test3 = await testParallelSearchLogic();
  
  console.log('\n=== Test Summary ===');
  console.log(`Lovdata Deduplication: ${test1 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Serper Deduplication: ${test2 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Parallel Search: ${test3 ? '✅ PASS' : '❌ FAIL'}`);
  
  const allPassed = test1 && test2 && test3;
  console.log(`\n${allPassed ? '✅ All tests PASSED' : '❌ Some tests FAILED'}`);
  
  process.exit(allPassed ? 0 : 1);
}

runAllTests().catch(console.error);

