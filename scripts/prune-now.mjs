import { VectorStore } from '../dist/vectorstore/index.js';
import { listSessions } from '../dist/sessions/summary.js';

const store = new VectorStore();
const before = store.stats();
console.log(`Before: ${before.uniqueSessions} indexed sessions, ${before.dbSizeMB} MB`);

const live = new Set(listSessions().map((s) => s.sessionId));
console.log(`Live sessions on disk: ${live.size}`);

const pruned = store.pruneOrphanSessions(live);
console.log(`Pruned: ${pruned.sessions} session(s), ${pruned.chunks} chunk(s)`);

const vac = store.vacuum();
console.log(
  `VACUUM: ${(vac.beforeBytes / 1024 / 1024).toFixed(1)} MB -> ${(vac.afterBytes / 1024 / 1024).toFixed(1)} MB (reclaimed ${(vac.reclaimedBytes / 1024 / 1024).toFixed(1)} MB)`,
);

const after = store.stats();
console.log(`After: ${after.uniqueSessions} indexed sessions, ${after.dbSizeMB} MB`);
store.close();
