# LoCoMo benchmark harness for UML

Measures UML's long-conversation memory on the [LoCoMo](https://github.com/snap-research/locomo)
dataset (via the [EasyLocomo](https://github.com/playeriv65/EasyLocomo) packaging),
end to end through the same REST API production serves.

## Methodology

Each of LoCoMo's 10 conversations is ingested into its own isolated UML user
(`locomo-conv-<N>`): under API-key auth the explicit `userId` is the memory
scope — its own D1 rows, Durable Object, and Vectorize namespace — so
conversations cannot contaminate each other. Every turn is sent through
`POST /v1/turn` (the production recall + auto-collect path) prefixed with the
session timestamp and speaker name; each session ends with a forced digest
(`POST /v1/ingest {flush:true}`), and the harness waits for background
extraction to settle before asking anything.

Per question, the harness calls `POST /v1/recall` with the question text and
passes only the recalled context plus the question to an answerer model, which
produces the short answer that is scored. **The answerer exists only for this
benchmark** — UML's recall path has no generative model; it returns memory, not
prose. The gold answer never appears in the recall query or the answerer
prompt. Category 5 (adversarial) is excluded, matching Mem0's and Zep's
published LoCoMo evaluations. No tuning was done on the questions.

Scoring: SQuAD-style token F1, plus an LLM judge that compares prediction to
gold. **Answerer and judge run on Cloudflare Workers AI (the model in
`LLM_MODEL`, Qwen3-30B at the time of the run), not gpt-4o-mini — so absolute
numbers are not directly comparable to published Mem0/Zep results**, which used
OpenAI models for answering and judging. They measure UML's recall quality
under a consistent local setup.

The answerer/judge reaches Workers AI through `POST /eval/llm`, a pass-through
route that only exists when `EVAL_MODE=1` is set (local `.dev.vars`) — it is
absent in production.

## Reproduce

```
git clone https://github.com/playeriv65/EasyLocomo evals/locomo/EasyLocomo
echo 'EVAL_MODE="1"' >> .dev.vars
npx wrangler dev --port 8799   # separate terminal
node evals/locomo/ingest.js 0 && node evals/locomo/ask.js 0 && node evals/locomo/score.js 0 && node evals/locomo/report.js 0
```

Raw per-question logs land in `evals/locomo/results/*.jsonl` (one line per
question: ids, category, question, raw recall response, extracted context,
answer, gold, F1, judge verdict, token estimate, latencies; ingest failures and
empty recalls are counted, not hidden).

## Known limitations

- Answerer/judge are Workers AI (Qwen3-30B), not gpt-4o-mini → no direct
  comparability with published Mem0/Zep numbers.
- Empty recalls are a known open behavior being tracked (`context_empty` in the
  logs) — they score as failures, not skips.
- LLM-judge grading is itself model-dependent; F1 is reported alongside it.
- Runs against `wrangler dev` with a local D1 (same code path as hosted UML,
  real Workers AI extraction); it is not a load test of the hosted deployment.
- Image turns contribute only their caption text (`blip_caption`), not pixels.
