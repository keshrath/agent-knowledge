// =============================================================================
// agent-knowledge — work in slices
//
// Building a search index reads every entry or session file: seconds of
// synchronous work. Run as steps, it gives the event loop back every few
// milliseconds, so the process holding the REST port keeps answering while it
// indexes.
// =============================================================================

const SLICE_MS = 20;

/** Runs every step, yielding to the event loop each time a slice of work is used up. */
export async function runSliced(steps: Iterable<unknown>): Promise<void> {
  let since = Date.now();
  const it = steps[Symbol.iterator]();
  while (!it.next().done) {
    if (Date.now() - since < SLICE_MS) continue;
    await new Promise<void>((resolve) => setImmediate(resolve));
    since = Date.now();
  }
}

/** Runs every step at once, for a caller that needs the result now. */
export function runAll(steps: Iterable<unknown>): void {
  const it = steps[Symbol.iterator]();
  while (!it.next().done) {
    /* each step does its work */
  }
}
