# Optional model gateway

The server loads `.env` at startup. `LITELLM_API_KEY` takes precedence over an
administrator-saved `liteLlmKey` in mode-0600 `.data/secrets.json`. Keys are never
returned by the API. Restart after changing environment credentials or URLs.

`LITELLM_BASE_URL` accepts a chat base URL (default `http://localhost:4000/v1`)
or the full `/chat/completions` URL. `LITELLM_DECISIONS_URL` is a separate full
OpenRouter Decisions passthrough URL. Both authenticate using the same restricted
gateway caller key. A hosted container needs gateway URLs reachable on its
private network; localhost inside the container refers to the container itself.

Hardware extraction uses JSON-object mode on the exact LiteLLM route
`xiaomi_mimo/mimo-v2.6-flash`, with bounded text and output tokens and disabled
thinking through `extra_body`. The system prompt includes the full contract
generated from the local validator and a valid example. The application enforces
the schema and source quotes; JSON mode alone does not enforce hardware fields.
An isolated numeric range failure in `profile.ramSpeedMhz` is recovered by leaving
that field null, removing its accepted evidence and retaining the other strictly
validated fields. The assessment records the discarded speed in its status;
standalone RAM still requires a verified speed before comparison. The observed
`priceBasis` aliases `multi` and `multiPrice` become `unknown`, discard evidence
for that rejected basis and require price review while retaining validated
hardware facts and multi-price flags/conflicts. These two recoveries can apply
together. Other schema violations retain the bounded corrective retry and
conservative fallback. The prompt distinguishes `flags.multiPrice` from the
five supported price bases and requires `unknown` for ambiguous pricing.
Seller typos are not repaired by adding/removing zeros: a plausible range does
not establish the actual installed speed.
Classification uses
`perplexity/pplx-decider-v1.2` on the dedicated Decisions state/questions API.
Do not prepend `openrouter/` to this Decisions model ID. Model availability needs
current gateway/provider verification; there is no silent model substitution.

Source-supported quotes are validated. AI never invents installed capacities,
market prices, comparisons or discounts. Missing keys, provider failures and
exhausted budgets leave conservative interpretation and fetched evidence available
with explicit status.

Classification runs for every listing the rules do not already exclude. Extraction
is the larger cost: in 100 classification and 98 extraction receipts from local
runs on 12–14 October 2026, before extraction was gated, an extraction averaged
USD 0.000211 and a classification USD 0.000054 (on Decider V1.1, listed at the
same price as V1.2), so extraction was about 80% of an assessment's AI cost.
What the gating saves on real scans has not been measured. Extraction runs only
when it can add comparable facts. It is skipped for MacBooks, whose
specifications the MacBook parser re-derives; when classification does not
accept the ad as a working used item at a cash price (working-used below 0.8, or
damage, lock/parts-only or deposit at 0.8 or more); and for laptops whose quoted
seller text already states model, processor, graphics (with video memory for a
discrete GPU), RAM, storage capacity and type.
Those assessments combine the rule parser's quoted facts with the classifier's
signals, and their status names the reason. Nationwide comparison offers whose own
text names only another processor (or graphics card, for card pools), or several,
are not sent to AI: they cannot match the pool's target.

Classifier and extractor outputs are cached by listing content under their own
versions (`DECIDER_OUTPUT_VERSION`, `EXTRACTION_OUTPUT_VERSION`), which change only
with a model, its prompt or its output schema. `AI_ASSESSMENT_VERSION` covers result
handling: increasing it rebuilds assessments from the cached outputs without new
requests, also when AI is off or its allowance is spent.

Manual jobs use the saved AI allowance (USD 0.50 by default) or a launch override.
Scheduled jobs use the saved allowance, capped at USD 0.50 for laptops and USD 0.25
each for desktops and graphics cards, with USD 1.00 in admitted allowances per
nominal Vietnam schedule day. Reservations are made before requests; unknown billing consumes
the reservation. The full category allowance is persisted before a scheduled
attempt, so a crash cannot replenish it. A provider-reported overage seals that
job's AI budget and reduces later category admission. These are request-admission
limits, not a guarantee about an external provider's final bill. A long category
can finish after midnight; its reservation remains assigned to its schedule day.

Each Chat request has a 120-second deadline; each Decisions request has 45 seconds,
including response-body reads. Each stage can make one extra attempt for a
connection failure, timeout, HTTP 408/429/5xx or malformed/incomplete output.
Extraction retries retain the successful classification. Output recovery includes
bounded field-path feedback without replaying invalid provider text. The normal
extraction cap is 4,096 output tokens; a truncation retry allows 8,192. Every
attempt reserves its full ceiling against the original job allowance.

Retry backoff is 250 milliseconds. A provider's longer `Retry-After` is honored
up to five seconds; longer waits fall back without an early retry. Cancellation,
authentication/input rejection, invalid billing metadata, unexpected models,
oversized responses and cost overages do not retry. Exhausted retries retain
conservative interpretation and a specific failure reason. Existing run history
and its warnings remain intact; this change does not replay completed runs.

Cancellation and
shutdown propagate abort signals, retain conservative reservations, and drain
background finalization before SQLite closes. The explicit Test AI action uses
its own bounded manual budget and can incur provider charges.

## MiMo structured-output research — 24 October 2026

Xiaomi retired the hosted `mimo-v2.5` and `mimo-v2.5-pro` names on 21 October
2026 at 10:00 UTC+8. Its documented replacement for `mimo-v2.5` is
`mimo-v2.6-flash`; downgrading the current native route is therefore unsuitable.
Source: [Xiaomi model deprecation](https://mimo.mi.com/docs/en-US/updates/deprecate).

Xiaomi documents `response_format: {"type":"json_object"}`. JSON mode controls
syntax; structure must be supplied in the prompt. Its guidance recommends
complete fields/types, examples, numeric ranges, explicit null handling, local
schema validation and an enhanced-prompt retry on failure.
Source: [Xiaomi structured outputs](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/structured-output).

The inspected LiteLLM 1.105.0 Xiaomi parameter mapper passes `response_format`
through unchanged. A locally reproduced mapping retained `json_schema` and
`strict: true`; it did not convert these into provider-enforced constraints.
Source: [LiteLLM parameter mapping](https://github.com/BerriAI/litellm/blob/v1.105.0/litellm/llms/openai_like/dynamic_config.py).

Xiaomi supports disabling thinking. Its completion limit includes reasoning and
visible output, and insufficient output capacity can truncate the answer.
Source: [Xiaomi thinking and output limits](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/deep-thinking).

Accepted implementation decision: retain 2.6 Flash, use documented
JSON-object mode, and put the full extraction contract plus a small valid example
in the system prompt. Generate that contract from the local validator so numeric
limits, enums and required fields agree. The former hand-written request schema
omitted numeric limits enforced by the validator; `extractionJSONSchema` now uses
the input contract of `extractionSchema` in [the client](../server/litellm.ts).

Keep strict field and source-quote validation; reject zero capacities rather
than guessing their meaning. Give a failed stage one corrective retry with
bounded validation feedback and sufficient output space, reserving its full cost
against the same job allowance. Retain conservative accounting for uncertain
charges, existing request deadlines, cancellation and rules fallback. Distinguish
transport, deadline, truncation, JSON and field-validation failures in diagnostics.

This choice is based on the documented contract, not a measured accuracy
comparison between models. No live model comparison was performed. The accepted
scope fixes future assessments and preserves historical warnings.

## Native MiMo JSON trailer — 24 October 2026

A subsequent run on the deployed revision still reported invalid hardware JSON.
Inspection of the gateway's private retained responses found 24 extraction
responses containing a complete JSON object followed by the exact literal
`parameter`. All had `finish_reason: stop`; this was not truncation. Corrective
retries recovered most, but an affected local listing still fell back to rules.

The extraction decoder now removes only this exact suffix immediately after a
closing object brace, then runs the same JSON parser, full schema and source-quote
validation. It rejects arbitrary prose, extra objects, repeated markers and
invalid field values. This avoids another paid call for an intact object without
guessing or repairing hardware facts. Synthetic regression fixtures contain no
seller/provider payloads. Original run warnings remain unchanged; focused listing
analysis can reassess the affected retained item within the normal admission and
budget gates.
