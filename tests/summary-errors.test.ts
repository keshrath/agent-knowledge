import { describe, it, expect } from 'vitest';
import { extractErrorPatterns } from '../src/sessions/summary.js';

const out = (content: string) => [{ role: 'tool_result', content }];

describe('the errors of a session summary', () => {
  it('finds an error line in any case, as a word', () => {
    const lines = extractErrorPatterns(
      out(
        [
          'collected 12 items',
          'FAILED tests/test_stock.py::test_reserve - AssertionError: 3 != 2',
          'psycopg2.errors.UniqueViolation: duplicate key value violates unique constraint',
          "Error: failed to push some refs to 'origin'",
          'Traceback (most recent call last):',
        ].join('\n'),
      ),
    );
    expect(lines).toEqual([
      'FAILED tests/test_stock.py::test_reserve - AssertionError: 3 != 2',
      'psycopg2.errors.UniqueViolation: duplicate key value violates unique constraint',
      "Error: failed to push some refs to 'origin'",
      'Traceback (most recent call last):',
    ]);
  });

  it('finds a coloured error, its escapes gone', () => {
    expect(
      extractErrorPatterns(out('\x1b[31mFAILED\x1b[0m tests/test_x.py::test_y - boom\nok')),
    ).toEqual(['FAILED tests/test_x.py::test_y - boom']);
  });

  it('a count of none, or a word that only contains one, is no error', () => {
    expect(
      extractErrorPatterns(
        out('Found 0 errors in 12 files.\n12 passed, 0 failed\nterrorist-free zone'),
      ),
    ).toEqual([]);
  });
});
