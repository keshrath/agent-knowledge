import { describe, it, expect } from 'vitest';
import { withoutControls } from '../src/text.js';
import { scrubContent } from '../src/knowledge/distill.js';
import { buildExcerpt } from '../src/search/excerpt.js';
import { excerptText } from '../src/knowledge/search.js';

const DIRTY = '\x1b[31mFAILED\x1b[0m test_x \x1b]0;window\x07 \x1b(B done\x07 \x9b2K\r\nnext';

describe('text without terminal control', () => {
  it('drops escape sequences whole, marks any other control, keeps newline and tab', () => {
    expect(withoutControls(DIRTY)).toBe('FAILED test_x   done� \nnext');
    expect(withoutControls('a\tb\nc')).toBe('a\tb\nc');
  });

  it('takes the C1 forms whole too: an OSC to its ST, a DCS, a CSI', () => {
    expect(withoutControls('a\x9d8;;https://x.test/\x9cb\x9d0;title\x07c')).toBe('abc');
    expect(withoutControls('a\x90q#0;2;0;0;0\x9cb \x1bP1$r\x1b\\c')).toBe('ab c');
    expect(withoutControls('a\x9b1;31mb\x1b]8;;u\x9cc')).toBe('abc');
  });

  it('is what a snapshot writes to git and what a search answers as excerpts', () => {
    // eslint-disable-next-line no-control-regex
    const isClean = (s: string) => !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(s);
    expect(isClean(scrubContent(DIRTY))).toBe(true);
    expect(isClean(buildExcerpt(DIRTY, 'FAILED'))).toBe(true);
    expect(isClean(excerptText(DIRTY))).toBe(true);
  });
});
