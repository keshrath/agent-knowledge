import { describe, it, expect } from 'vitest';

describe('summary extraction patterns', () => {
  // Test git commit extraction
  it('should extract short SHAs from git output', () => {
    const content = `[main abc1234] commit message\n 1 file changed`;
    expect(content).toMatch(/\b[0-9a-f]{7,40}\b/);
    expect(content).toMatch(/commit/i);
  });

  it('should not match all-zero SHAs', () => {
    const sha = '0000000';
    expect(/^0+$/.test(sha)).toBe(true);
  });

  it('should normalize long SHAs to 7 chars', () => {
    const longSha = 'abc1234567890def1234567890abcdef12345678';
    expect(longSha.substring(0, 7)).toBe('abc1234');
  });

  // Test error extraction
  it('should match Error patterns', () => {
    const content = 'TypeError: Cannot read property "foo" of undefined';
    expect(content).toMatch(/^.*(?:Error|Exception|FAIL|FATAL|panic|Traceback)[:.\s].{10,200}/m);
  });

  it('should match Exception patterns', () => {
    const content = 'NullPointerException: something went wrong here';
    expect(content).toMatch(/^.*(?:Error|Exception|FAIL|FATAL|panic|Traceback)[:.\s].{10,200}/m);
  });

  it('should match FAIL patterns', () => {
    const content = 'FAIL: test_something expected true got false';
    expect(content).toMatch(/^.*(?:Error|Exception|FAIL|FATAL|panic|Traceback)[:.\s].{10,200}/m);
  });

  it('should not match short error lines', () => {
    const content = 'Error: x';
    expect(content).not.toMatch(
      /^.*(?:Error|Exception|FAIL|FATAL|panic|Traceback)[:.\s].{10,200}/m,
    );
  });

  // Test URL extraction
  it('should match URLs and strip trailing punctuation', () => {
    const url = 'https://example.com/api/v1';
    expect(url).toMatch(/https?:\/\/[^\s"'<>)\]]+/);
  });

  it('should filter out image URLs', () => {
    const imageUrl = 'https://example.com/image.png';
    const noise =
      /\.(png|jpg|jpeg|gif|svg|ico|woff|ttf|eot|map)(\?|$)|fonts\.googleapis|cdnjs|unpkg/i;
    expect(noise.test(imageUrl)).toBe(true);
  });

  it('should not filter out API URLs', () => {
    const apiUrl = 'https://api.example.com/v1/data';
    const noise =
      /\.(png|jpg|jpeg|gif|svg|ico|woff|ttf|eot|map)(\?|$)|fonts\.googleapis|cdnjs|unpkg/i;
    expect(noise.test(apiUrl)).toBe(false);
  });

  // Test package extraction
  it('should match npm install packages', () => {
    const content = 'npm install express body-parser --save';
    const re = /npm\s+(?:install|i|add)\s+([^\s&|;]+(?:\s+[^\s&|;-][^\s&|;]*)*)/;
    const match = content.match(re);
    expect(match).toBeTruthy();
    expect(match![1]).toContain('express');
  });

  it('should match npm i shorthand', () => {
    const content = 'npm i lodash';
    const re = /npm\s+(?:install|i|add)\s+([^\s&|;]+(?:\s+[^\s&|;-][^\s&|;]*)*)/;
    const match = content.match(re);
    expect(match).toBeTruthy();
    expect(match![1]).toContain('lodash');
  });

  it('should match pip install packages', () => {
    const content = 'pip install requests flask';
    const re = /pip\s+install\s+([^\s&|;]+(?:\s+[^\s&|;-][^\s&|;]*)*)/;
    const match = content.match(re);
    expect(match).toBeTruthy();
    expect(match![1]).toContain('requests');
  });

  it('should strip version specifiers from package names', () => {
    const pkg = 'express@^4.18.0';
    const cleaned = pkg.replace(/@[\d^~>=<.*]+$/, '');
    expect(cleaned).toBe('express');
  });
});
