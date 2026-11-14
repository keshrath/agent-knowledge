// =============================================================================
// agent-knowledge — Live event ring
//
// A short in-memory buffer of recent events (session-end receipts, distill
// results) that hooks POST to /api/events and the /knowledge pane reads.
// Unpersisted: the authoritative receipts land on disk as session files.
// The oldest event drops when the ring is full.
// =============================================================================

export interface LiveEvent {
  id: number;
  kind: string;
  message: string;
  ts: number;
}

const EVENT_RING_MAX = 10;
const ring: LiveEvent[] = [];
let lastId = 0;

/**
 * Ids rise across processes, not only within one: each is the time it was recorded (in ms),
 * or one past the last when two come in the same ms. A process that takes the port over
 * after another goes on above the ids that one gave, so a reader that remembers the highest
 * id it saw (the pane) sees the new events, not none until the ids catch up.
 */
export function recordEvent(kind: string, message: string): LiveEvent {
  const ts = Date.now();
  lastId = Math.max(lastId + 1, ts);
  const evt: LiveEvent = { id: lastId, kind, message, ts };
  ring.push(evt);
  while (ring.length > EVENT_RING_MAX) ring.shift();
  return evt;
}

/** The ring's events, oldest first. */
export function recentEvents(): LiveEvent[] {
  return ring.slice();
}
