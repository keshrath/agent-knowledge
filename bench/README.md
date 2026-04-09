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

### Reproducible results — agent-knowledge v1.5.1

Full 500 questions, no LLM, no API key, runs entirely offline. Reproduce with `npx tsx bench/longmemeval.ts --boosts --ranker bm25` (sparse) or `--hybrid --boosts --ranker bm25` (hybrid).

#### Headline (longmemeval_s_cleaned, 54 distractor sessions per question)

| Mode                             | n   | R@1       | R@5       | R@10      | Time   |
| -------------------------------- | --- | --------- | --------- | --------- | ------ |
| 1.4.2 — TF-IDF + boosts          | 500 | 59.8%     | 83.8%     | 91.2%     | 9.3s   |
| **1.5 — BM25 + boosts**          | 500 | **87.6%** | **97.2%** | **98.4%** | 8.3s   |
| **1.5 — BM25 + semantic hybrid** | 500 | **89.6%** | **98.8%** | **99.6%** | ~70min |

#### Per-question-type breakdown (1.5 BM25 + boosts, longmemeval_s_cleaned)

| Category                  | n   | R@1    | R@5    | R@10   |
| ------------------------- | --- | ------ | ------ | ------ |
| single-session-user       | 70  | 92.9%  | 100.0% | 100.0% |
| single-session-assistant  | 56  | 100.0% | 100.0% | 100.0% |
| single-session-preference | 30  | 43.3%  | 86.7%  | 90.0%  |
| multi-session             | 133 | 87.2%  | 97.0%  | 98.5%  |
| temporal-reasoning        | 133 | 83.5%  | 95.5%  | 97.7%  |
| knowledge-update          | 78  | 98.7%  | 100.0% | 100.0% |

#### Harder split — longmemeval_m (500 distractor sessions per question, ~10× harder)

| Mode                             | R@1       | R@5       | R@10      | Time     |
| -------------------------------- | --------- | --------- | --------- | -------- |
| **1.5 — BM25 + boosts (sparse)** | **65.6%** | **86.0%** | **92.4%** | ~2.2 min |
| **1.5 — BM25 + semantic hybrid** | **65.4%** | **88.4%** | **92.2%** | ~9.7 hr  |

`_m` is the same 500 questions but with ~500 candidate sessions per question instead of ~54, so the retriever has 10× more distractors to discriminate against. The drop from `_s` is expected; the relative ordering of categories holds.

### Validation against the LongMemEval paper baseline

We re-ran the LongMemEval paper's official `flat-bm25` implementation (`src/retrieval/run_retrieval.py` from `xiaowu0162/longmemeval`) on the same data, using the paper's exact corpus construction (user-only text per session), tokenization (`doc.split(" ")`, no normalization), and `rank_bm25.BM25Okapi` defaults. Eval metric is the paper's own `recall_any@k` from `eval_utils.py`. Both implementations produce identical metrics on the same questions; the only difference is the BM25 setup.

| Split           | Paper `flat-bm25` | agent-knowledge 1.5 BM25 | agent-knowledge 1.5 hybrid |
| --------------- | ----------------- | ------------------------ | -------------------------- |
| `longmemeval_s` | 88.6% R@5         | **97.2% (+8.6pp)**       | **98.8% (+10.2pp)**        |
| `longmemeval_m` | 75.2% R@5         | **86.0% (+10.8pp)**      | **88.4% (+13.2pp)**        |

Why we beat the paper's BM25 on the same algorithm:

1. **We index both user and assistant turns** (the paper indexes user-only). LongMemEval queries often reference content the assistant produced; user-only loses that signal.
2. **We lowercase + strip stopwords** (the paper splits on whitespace with no normalization). Stopword removal sharpens IDF.
3. **`k1 = 1.2` instead of `BM25Okapi`'s default `1.5`**. Lower k1 reduces the saturation of high-TF terms, which helps when documents are long conversations.

The improvement is consistent across both splits (+8.6pp on `_s`, +10.8pp on `_m`) and grows on the harder split, suggesting the wins compound rather than being an artifact of the easier setting.

Reproduce the paper baseline yourself:

```bash
pip install rank_bm25 numpy
python bench/paper_bm25_eval.py ~/.claude/tmp/longmemeval/longmemeval_s_cleaned.json
python bench/paper_bm25_eval.py ~/.claude/tmp/longmemeval/longmemeval_m.json
```

### Caveats

- **Single run, no variance bars.** The bench is deterministic for sparse-only; semantic uses a fixed quantized MiniLM with no sampling. Re-running yields the same numbers byte-for-byte.
- **Retrieval R@5 is not QA accuracy.** Many third-party "memory system" papers report end-to-end QA correctness (retrieval × LLM judge), which is a different and not directly comparable metric. We measure retrieval only.
- **No comparison vs the paper's dense retrievers** (Stella V5, GTE, Contriever) in their full framework. Those need a GPU plus the 1.5B Stella model. The single Table 3 cell we have (`_m`, value=round, K=V+fact, Stella V5) reports 64.4% R@5; our `_m` BM25 lands at 86.0%, but this is a single-cell comparison across different granularities and key-expansions, so we don't claim it broadly.
- **`single-session-preference` is the only weak category** even after the BM25 swap (86.7% sparse / 93.3% hybrid on `_s`, 46.7% sparse / 56.7% hybrid on `_m`). Preferences are stated indirectly and remain a real semantic gap.

### Notes

- The semantic / hybrid modes use the local Hugging Face model via `@huggingface/transformers` (an optional dep — already shipped). First run downloads the ~25 MB quantized MiniLM model.
- Embedding cost: ~150 chunks per question × 500 questions ≈ 75 000 embeddings. On a single machine this is ~30 minutes for the full 500.
- Set `KNOWLEDGE_EMBEDDING_THREADS` to control parallelism (default 1, the local provider uses 1 ONNX thread).
- Add `--alpha 0.5` to bias hybrid scoring toward TF-IDF (default `0.3`).
