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
let nextId = 1;

export function recordEvent(kind: string, message: string): LiveEvent {
  const evt: LiveEvent = { id: nextId++, kind, message, ts: Date.now() };
  ring.push(evt);
  while (ring.length > EVENT_RING_MAX) ring.shift();
  return evt;
}

/** The ring's events, oldest first. */
export function recentEvents(): LiveEvent[] {
  return ring.slice();
}
