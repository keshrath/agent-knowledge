import { describe, it, expect, vi } from 'vitest';

describe('live event ids', () => {
  it('rise within a process, two in the same ms included', async () => {
    const { recordEvent } = await import('../src/events.js');
    const a = recordEvent('distill', 'a');
    const b = recordEvent('distill', 'b');
    expect(b.id).toBeGreaterThan(a.id);
  });

  it('go on rising in the process that takes the port over: a reader that saw the old ones sees the new', async () => {
    vi.resetModules();
    const first = await import('../src/events.js');
    // A busy first process: many events, its ids running ahead of the clock.
    let seen = 0;
    for (let i = 0; i < 50; i++) seen = first.recordEvent('distill', `old ${i}`).id;
    await new Promise((r) => setTimeout(r, 100));
    // The process that takes over starts with an empty ring of its own.
    vi.resetModules();
    const next = await import('../src/events.js');
    expect(next.recordEvent('session-end', 'new').id).toBeGreaterThan(seen);
  });
});
