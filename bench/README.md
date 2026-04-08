# agent-knowledge bench

Two benchmark suites:

1. **`run.ts`** — small smoke benchmark over real `~/agent-knowledge/` content (22 hand-authored fixtures, 5 categories). Use this to check regressions on local content.
2. **`longmemeval.ts`** — the academic [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval) benchmark (Wu et al. 2024, ICLR 2025), 500 questions across 6 question types.

---

## 1. Local smoke benchmark — `run.ts`

Tiny R@5 / R@10 benchmark over real `~/agent-knowledge/` content.

## Run

```bash
npm run build
npm run bench
```

The runner imports `searchKnowledge` directly from `dist/` — no MCP wrapping,
no embedding-provider startup time. It prints a per-category recall table
and lists every miss to stderr so you can iterate.

## Add a fixture

Append one JSON line to `bench/fixtures.jsonl`:

```jsonl
{
  "query": "how do I configure the database connection",
  "expected": "workflows/db-setup.md",
  "category": "multi-hop"
}
```

Suggested categories: `factual-lookup`, `multi-hop`, `temporal`, `preference`, `adversarial`.

`bench/fixtures.jsonl` is gitignored — author your own fixtures against your own `~/agent-knowledge/` content. A small example file is checked in as `bench/fixtures.example.jsonl`.

---

## 2. LongMemEval — `longmemeval.ts`

[LongMemEval](https://arxiv.org/abs/2410.10813) (Wu et al. 2024, ICLR 2025) is a public academic benchmark for long-term memory retrieval in conversational agents. 500 questions across 6 question types, ~54 candidate sessions per question. The task: retrieve which session(s) contain the answer.

### Setup

Download the dataset (~264 MB, one time):

```bash
mkdir -p ~/.claude/tmp/longmemeval
curl -L -o ~/.claude/tmp/longmemeval/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
```

Override the path with `LONGMEMEVAL_PATH` if you store it elsewhere.

### Run

```bash
# Pure TF-IDF (sparse baseline) — no embedding model needed
npx tsx bench/longmemeval.ts

# TF-IDF + v1.4 boosts (proper-noun + temporal proximity)
npx tsx bench/longmemeval.ts --boosts

# Local semantic only (Xenova/all-MiniLM-L6-v2 via @huggingface/transformers)
npx tsx bench/longmemeval.ts --semantic

# Hybrid: TF-IDF + semantic + boosts (the v1.4 search path)
npx tsx bench/longmemeval.ts --hybrid --boosts

# Quick smoke on a subset
npx tsx bench/longmemeval.ts --hybrid --boosts --limit 50
```

Per-question type breakdown is printed alongside the overall score so you can see exactly which categories a change moves.

### Reproducible results — agent-knowledge v1.4.2

Full 500 questions on `longmemeval_s_cleaned`, no LLM, no API key, runs entirely offline.
Reproduce with `npx tsx bench/longmemeval.ts` (raw) or `--boosts` for the v1.4 scoring boosts.

| Mode                     | n   | R@1   | R@5       | R@10      | Time |
| ------------------------ | --- | ----- | --------- | --------- | ---- |
| Raw TF-IDF (sparse only) | 500 | 54.0% | 81.8%     | 89.2%     | 8.6s |
| TF-IDF + boosts          | 500 | 59.8% | **83.8%** | **91.2%** | 9.3s |

#### Per-question-type breakdown (boosts mode)

| Category                  | n   | R@1   | R@5   | R@10  |
| ------------------------- | --- | ----- | ----- | ----- |
| single-session-user       | 70  | 62.9% | 90.0% | 92.9% |
| single-session-assistant  | 56  | 76.8% | 87.5% | 94.6% |
| single-session-preference | 30  | 10.0% | 33.3% | 50.0% |
| multi-session             | 133 | 58.6% | 84.2% | 92.5% |
| temporal-reasoning        | 133 | 59.4% | 84.2% | 93.2% |
| knowledge-update          | 78  | 66.7% | 93.6% | 97.4% |

The boosts add the biggest lift exactly where they target:

- **single-session-assistant R@1: +16.1pp** (proper-noun boost)
- **temporal-reasoning R@1: +6.8pp** (temporal-proximity boost)
- **knowledge-update R@5: +1.3pp**

The dead spot is **single-session-preference** (33.3% R@5). Preferences are stated indirectly ("I usually prefer X") and TF-IDF can't bridge the vocabulary gap. The hybrid mode (`--hybrid --boosts`) adds local MiniLM semantic search and lifts categories where TF-IDF struggles, at the cost of ~110 minutes for the full 500-question run.

### Notes

- The semantic / hybrid modes use the local Hugging Face model via `@huggingface/transformers` (an optional dep — already shipped). First run downloads the ~25 MB quantized MiniLM model.
- Embedding cost: ~150 chunks per question × 500 questions ≈ 75 000 embeddings. On a single machine this is ~30 minutes for the full 500.
- Set `KNOWLEDGE_EMBEDDING_THREADS` to control parallelism (default 1, the local provider uses 1 ONNX thread).
- Add `--alpha 0.5` to bias hybrid scoring toward TF-IDF (default `0.3`).
