import { describe, expect, it } from 'vitest';
import { __test__ } from '../index.js';

describe('Serper skill normalizeInput', () => {
  it('accepts plain string queries', () => {
    const command = __test__.normalizeInput('arbeidsmiljøloven krav');
    expect(command.query).toBe('arbeidsmiljøloven krav');
  });

  it('validates structured queries', () => {
    const command = __test__.normalizeInput({ query: 'lovdata site search', num: 5 });
    expect(command).toMatchObject({ query: 'lovdata site search', num: 5 });
  });

  it('throws for missing query', () => {
    expect(() => __test__.normalizeInput({} as any)).toThrow('Serper skill requires a string query');
  });
});
