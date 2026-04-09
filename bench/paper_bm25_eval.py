"""
Run the LongMemEval paper's exact flat-bm25 baseline on a dataset and
report recall_any@K. Mirrors src/retrieval/run_retrieval.py from the paper
with corpus construction = user-only text per session, tokenization =
doc.split(" "), library = rank_bm25.BM25Okapi (default k1=1.5, b=0.75).
Eval = exact same recall_any from src/retrieval/eval_utils.py.

Usage: python paper_bm25_eval.py <dataset.json> [--limit N]
"""

import json, sys, time
from rank_bm25 import BM25Okapi
import numpy as np

path = sys.argv[1]
limit = 0
if "--limit" in sys.argv:
    limit = int(sys.argv[sys.argv.index("--limit") + 1])

print(f"Loading {path}...", file=sys.stderr)
t0 = time.time()
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
print(f"Loaded {len(data)} questions in {time.time()-t0:.1f}s", file=sys.stderr)
if limit > 0:
    data = data[:limit]


def process_session(session, sess_id):
    """Paper: user-turns concatenated."""
    text = " ".join(
        [interact["content"] for interact in session if interact["role"] == "user"]
    )
    return text, sess_id


def evaluate_retrieval(rankings, correct_docs, corpus_ids, k):
    recalled = set(corpus_ids[idx] for idx in rankings[:k])
    return float(any(d in recalled for d in correct_docs))


buckets = {}
overall = {1: 0, 5: 0, 10: 0, "n": 0}

for q in data:
    if len(q["haystack_sessions"]) != len(q["haystack_session_ids"]):
        continue
    corpus, corpus_ids = [], []
    for sid, sess in zip(q["haystack_session_ids"], q["haystack_sessions"]):
        text, cid = process_session(sess, sid)
        corpus.append(text)
        corpus_ids.append(cid)
    correct = set(q["answer_session_ids"])
    tokenized = [doc.split(" ") for doc in corpus]
    bm25 = BM25Okapi(tokenized)
    scores = bm25.get_scores(q["question"].split(" "))
    rankings = list(np.argsort(scores)[::-1])

    qt = q.get("question_type", "unknown")
    b = buckets.setdefault(qt, {1: 0, 5: 0, 10: 0, "n": 0})
    b["n"] += 1
    overall["n"] += 1
    for k in (1, 5, 10):
        hit = evaluate_retrieval(rankings, correct, corpus_ids, k)
        b[k] += hit
        overall[k] += hit
    if overall["n"] % 50 == 0:
        print(f"  {overall['n']}/{len(data)}", file=sys.stderr)

print()
print("# Paper's flat-bm25 reproduction")
print(f"Dataset: {path.split('/')[-1]}")
print(f"Processed: {overall['n']} questions")
print()
print("| Question type | n | R@1 | R@5 | R@10 |")
print("|---|---|---|---|---|")
order = [
    "single-session-user",
    "single-session-assistant",
    "single-session-preference",
    "multi-session",
    "temporal-reasoning",
    "knowledge-update",
]
for name in order:
    if name not in buckets:
        continue
    b = buckets[name]
    n = b["n"]
    print(
        f"| {name} | {n} | {b[1]/n*100:.1f}% | {b[5]/n*100:.1f}% | {b[10]/n*100:.1f}% |"
    )
n = overall["n"]
print(
    f"| **OVERALL** | **{n}** | **{overall[1]/n*100:.1f}%** | **{overall[5]/n*100:.1f}%** | **{overall[10]/n*100:.1f}%** |"
)
