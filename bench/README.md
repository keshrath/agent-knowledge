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
  "query": "how do we deploy lastloop",
  "expected": "workflows/lastloop-cicd-deployment-sop.md",
  "category": "multi-hop"
}
```

Suggested categories: `factual-lookup`, `multi-hop`, `temporal`, `preference`, `adversarial`.

## Why this exists

Without a measurable benchmark, every change to scoring/boost/category logic in `agent-knowledge` is vibes-based. With it, you can A/B any change in seconds and see exactly which question categories a tweak moves.

The fixture is small (~22 entries) on purpose — large enough to surface regressions, small enough to hand-author and edit.

---

## 2. LongMemEval — `longmemeval.ts`

[LongMemEval](https://arxiv.org/abs/2410.10813) (Wu et al. 2024, ICLR 2025) is a public academic benchmark for long-term memory retrieval in conversational agents. 500 questions across 6 question types, ~54 candidate sessions per question. The task: retrieve which session(s) contain the answer.

### Setup

Download the dataset (~265 MB, one time):

```bash
mkdir -p ~/.claude/tmp/longmemeval
curl -L -o ~/.claude/tmp/longmemeval/longmemeval_s.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s
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

### Reproducible results — agent-knowledge v1.4.0

No LLM, no API key, runs entirely offline.

| Mode                           | n   | R@1   | R@5       | R@10      |
| ------------------------------ | --- | ----- | --------- | --------- |
| Raw TF-IDF (sparse only)       | 500 | 54.0% | 81.6%     | 89.2%     |
| TF-IDF + v1.4 boosts           | 500 | 60.0% | 83.6%     | 91.2%     |
| Hybrid (TF-IDF + sem + boosts) | 100 | 77.0% | **96.0%** | **97.0%** |

Notes:

- The hybrid number is on the first 100 questions, which cover only `single-session-user` (70) and `multi-session` (30). On those two categories specifically, hybrid lifts R@5 from 90.0% / 84.2% (boosts mode) to **95.7% / 96.7%**. The full 500-question hybrid run takes ~110 minutes on a single machine and is left as a regression run.
- The TF-IDF + boosts numbers are on the full 500-question dataset.

The v1.4 boosts add the biggest lift exactly where they target:

- **single-session-assistant R@1: +16.1pp** (proper-noun boost)
- **temporal-reasoning R@1: +7.6pp** (temporal-proximity boost)
- **knowledge-update R@5: +1.3pp**

### Notes

- The semantic / hybrid modes use the local Hugging Face model via `@huggingface/transformers` (an optional dep — already shipped). First run downloads the ~25 MB quantized MiniLM model.
- Embedding cost: ~150 chunks per question × 500 questions ≈ 75 000 embeddings. On a single machine this is ~30 minutes for the full 500.
- Set `KNOWLEDGE_EMBEDDING_THREADS` to control parallelism (default 1, the local provider uses 1 ONNX thread).
- Add `--alpha 0.5` to bias hybrid scoring toward TF-IDF (default `0.3`).
