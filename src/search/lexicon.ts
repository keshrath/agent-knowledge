import { tokenize } from './bm25.js';

/**
 * What the knowledge base says a word is. Two counts: how many of the person's sessions (the
 * snapshots) say it, and how many curated entries it names (in their title, path or tags) of
 * those that use it. A word said in many sessions that names almost no entry (commit, push,
 * add, file, build) is generic: what anyone asks about any code. A word entries are named by
 * (agent-tasks, hoot, release) is what the base is about, however often it is said.
 */
export class Lexicon {
  private readonly used = new Map<string, number>();
  private readonly named = new Map<string, number>();
  private readonly said = new Map<string, number>();
  private readonly heads = new Map<string, Set<string>>();
  private readonly bodies = new Map<string, Set<string>>();
  private readonly sessions = new Map<string, Set<string>>();

  /** Adds (or replaces) a curated entry: its title, path and tags, then all its text. */
  add(id: string, head: string, text: string): void {
    this.remove(id);
    const h = new Set(tokenize(head));
    const b = new Set([...tokenize(text), ...h]);
    this.heads.set(id, h);
    this.bodies.set(id, b);
    count(this.named, h, 1);
    count(this.used, b, 1);
  }

  /** Adds (or replaces) a session snapshot: what was said in it. */
  addSession(id: string, text: string): void {
    this.remove(id);
    const s = new Set(tokenize(text));
    this.sessions.set(id, s);
    count(this.said, s, 1);
  }

  remove(id: string): void {
    count(this.named, this.heads.get(id), -1);
    count(this.used, this.bodies.get(id), -1);
    count(this.said, this.sessions.get(id), -1);
    this.heads.delete(id);
    this.bodies.delete(id);
    this.sessions.delete(id);
  }

  /** Whether a curated entry uses the term. */
  knows(term: string): boolean {
    return (this.used.get(term) ?? 0) > 0;
  }

  /**
   * How much the term tells about a curated entry that uses it: its IDF over them (BM25's),
   * the sessions apart (a word said in every session is not rare among the entries for it).
   */
  weight(term: string): number {
    const n = this.bodies.size;
    const df = this.used.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Whether the term tells entries apart: used by some, not by most (a tenth of a rare one's IDF). */
  isTelling(term: string): boolean {
    const df = this.used.get(term) ?? 0;
    const n = this.bodies.size;
    return df > 0 && this.weight(term) >= Math.log(1 + (n - 0.5) / 1.5) / 10;
  }

  /** Whether the entry is named by the term: in its title, path or tags. */
  names(id: string, term: string): boolean {
    return this.heads.get(id)?.has(term) ?? false;
  }

  /**
   * Whether the term is generic: said in a tenth of the sessions or more (of twenty at least:
   * fewer cannot tell), and naming under a tenth of the entries that use it.
   */
  isGeneric(term: string): boolean {
    const n = this.sessions.size;
    if (n < MIN_SESSIONS || (this.said.get(term) ?? 0) < n * SAID_SHARE) return false;
    const used = this.used.get(term) ?? 0;
    return used === 0 || (this.named.get(term) ?? 0) / used < NAMED_SHARE;
  }
}

function count(m: Map<string, number>, terms: Set<string> | undefined, by: number) {
  for (const t of terms ?? []) m.set(t, (m.get(t) ?? 0) + by);
}

const MIN_SESSIONS = 20;
const SAID_SHARE = 0.1;
const NAMED_SHARE = 0.1;
