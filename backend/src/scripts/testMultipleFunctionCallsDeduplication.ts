#!/usr/bin/env tsx
/**
 * Test to verify deduplication works correctly when multiple function calls
 * happen in the same iteration
 */

type MockEvidence = {
  id: string;
  source: string;
  link?: string | null;
  metadata?: {
    filename?: string;
    member?: string;
  };
};

function testMultipleFunctionCallsDeduplication() {
  console.log('\n=== Testing Multiple Function Calls Deduplication ===');
  
  // Simulate agentEvidence accumulating across multiple function calls in same iteration
  let agentEvidence: MockEvidence[] = [];
  
  // First function call - lovdata search
  const lovdataEvidence1: MockEvidence[] = [
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
  
  // Deduplicate and add (simulating first function call)
  const existingKeys1 = new Set(agentEvidence.map(e => `${e.metadata?.filename}:${e.metadata?.member}`));
  const unique1 = lovdataEvidence1.filter(e => {
    const key = `${e.metadata?.filename}:${e.metadata?.member}`;
    if (existingKeys1.has(key)) {
      return false;
    }
    existingKeys1.add(key);
    return true;
  });
  agentEvidence = [...agentEvidence, ...unique1];
  
  console.log('After first function call (lovdata):', agentEvidence.length);
  
  // Second function call - same lovdata search (should deduplicate)
  const lovdataEvidence2: MockEvidence[] = [
    {
      id: 'lovdata-3',
      source: 'lovdata',
      metadata: { filename: 'archive1.tbz2', member: 'doc2.xml' } // Duplicate
    },
    {
      id: 'lovdata-4',
      source: 'lovdata',
      metadata: { filename: 'archive1.tbz2', member: 'doc3.xml' } // New
    }
  ];
  
  // Deduplicate and add (simulating second function call)
  const existingKeys2 = new Set(agentEvidence.map(e => `${e.metadata?.filename}:${e.metadata?.member}`));
  const unique2 = lovdataEvidence2.filter(e => {
    const key = `${e.metadata?.filename}:${e.metadata?.member}`;
    if (existingKeys2.has(key)) {
      return false;
    }
    existingKeys2.add(key);
    return true;
  });
  agentEvidence = [...agentEvidence, ...unique2];
  
  console.log('After second function call (lovdata):', agentEvidence.length);
  
  // Third function call - serper search
  const serperEvidence: MockEvidence[] = [
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
  
  // Deduplicate by link
  const existingLinks = new Set(agentEvidence.map(e => e.link).filter(Boolean));
  const unique3 = serperEvidence.filter(e => {
    if (!e.link || existingLinks.has(e.link)) {
      return false;
    }
    existingLinks.add(e.link);
    return true;
  });
  agentEvidence = [...agentEvidence, ...unique3];
  
  console.log('After third function call (serper):', agentEvidence.length);
  
  // Verify final count: 2 (initial) + 1 (new from 2nd call) + 2 (serper) = 5
  const expectedCount = 5;
  const actualCount = agentEvidence.length;
  const success = actualCount === expectedCount;
  
  console.log(`\n✅ Expected ${expectedCount} items, got ${actualCount}: ${success ? 'PASS' : 'FAIL'}`);
  
  // Verify no duplicates
  const lovdataKeys = agentEvidence
    .filter(e => e.source === 'lovdata')
    .map(e => `${e.metadata?.filename}:${e.metadata?.member}`);
  const uniqueLovdataKeys = new Set(lovdataKeys);
  const lovdataHasDuplicates = lovdataKeys.length !== uniqueLovdataKeys.size;
  
  const serperLinks = agentEvidence
    .filter(e => e.source.startsWith('serper'))
    .map(e => e.link)
    .filter(Boolean);
  const uniqueSerperLinks = new Set(serperLinks);
  const serperHasDuplicates = serperLinks.length !== uniqueSerperLinks.size;
  
  console.log(`✅ No Lovdata duplicates: ${!lovdataHasDuplicates ? 'PASS' : 'FAIL'}`);
  console.log(`✅ No Serper duplicates: ${!serperHasDuplicates ? 'PASS' : 'FAIL'}`);
  
  return success && !lovdataHasDuplicates && !serperHasDuplicates;
}

// Test edge case: missing metadata
function testMissingMetadata() {
  console.log('\n=== Testing Missing Metadata Edge Case ===');
  
  const agentEvidence: MockEvidence[] = [
    {
      id: 'lovdata-1',
      source: 'lovdata',
      metadata: { filename: 'archive1.tbz2', member: 'doc1.xml' }
    }
  ];
  
  const newEvidence: MockEvidence[] = [
    {
      id: 'lovdata-2',
      source: 'lovdata',
      // Missing metadata - should still work
      metadata: undefined
    },
    {
      id: 'lovdata-3',
      source: 'lovdata',
      metadata: { filename: 'archive1.tbz2', member: 'doc1.xml' } // Duplicate
    }
  ];
  
  // This should handle undefined metadata gracefully
  const existingKeys = new Set(agentEvidence.map(e => `${e.metadata?.filename}:${e.metadata?.member}`));
  const uniqueNewEvidence = newEvidence.filter(e => {
    const key = `${e.metadata?.filename}:${e.metadata?.member}`;
    if (existingKeys.has(key)) {
      return false;
    }
    existingKeys.add(key);
    return true;
  });
  
  // Should include item with undefined metadata (key becomes "undefined:undefined")
  // and exclude duplicate
  const hasUndefined = uniqueNewEvidence.some(e => !e.metadata);
  const noDuplicate = !uniqueNewEvidence.some(e => 
    e.metadata?.filename === 'archive1.tbz2' && e.metadata?.member === 'doc1.xml'
  );
  
  console.log(`✅ Handles missing metadata gracefully: ${hasUndefined ? 'PASS' : 'FAIL'}`);
  console.log(`✅ Still deduplicates correctly: ${noDuplicate ? 'PASS' : 'FAIL'}`);
  
  return hasUndefined && noDuplicate;
}

async function runAllTests() {
  console.log('🧪 Testing Multiple Function Calls and Edge Cases\n');
  
  const test1 = testMultipleFunctionCallsDeduplication();
  const test2 = testMissingMetadata();
  
  console.log('\n=== Test Summary ===');
  console.log(`Multiple Function Calls: ${test1 ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Missing Metadata Edge Case: ${test2 ? '✅ PASS' : '❌ FAIL'}`);
  
  const allPassed = test1 && test2;
  console.log(`\n${allPassed ? '✅ All tests PASSED' : '❌ Some tests FAILED'}`);
  
  process.exit(allPassed ? 0 : 1);
}

runAllTests().catch(console.error);

