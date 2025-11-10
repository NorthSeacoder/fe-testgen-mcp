import { describe, it, expect } from 'vitest';
import { extractRevisionId } from './revision.js';

describe('extractRevisionId', () => {
  it('should extract revision ID from D12345 format', () => {
    expect(extractRevisionId('D12345')).toBe('D12345');
  });

  it('should extract revision ID from lowercase d12345 format', () => {
    expect(extractRevisionId('d12345')).toBe('D12345');
  });

  it('should extract revision ID from just numbers', () => {
    expect(extractRevisionId('12345')).toBe('D12345');
  });

  it('should extract revision ID from Chinese message with D prefix', () => {
    expect(extractRevisionId('帮我 review 一下这个 diff D12345')).toBe('D12345');
  });

  it('should extract revision ID from English message with D prefix', () => {
    expect(extractRevisionId('review this diff D12345')).toBe('D12345');
  });

  it('should extract revision ID with spaces like "D 12345"', () => {
    expect(extractRevisionId('D 12345')).toBe('D12345');
  });

  it('should extract revision ID from "diff 12345" format', () => {
    expect(extractRevisionId('diff 12345')).toBe('D12345');
  });

  it('should return null for empty string', () => {
    expect(extractRevisionId('')).toBe(null);
  });

  it('should return null for null', () => {
    expect(extractRevisionId(null)).toBe(null);
  });

  it('should return null for undefined', () => {
    expect(extractRevisionId(undefined)).toBe(null);
  });

  it('should return null for invalid input', () => {
    expect(extractRevisionId('invalid')).toBe(null);
  });
});
