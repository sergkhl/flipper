# Separate LiteLLM extraction and Decisions contracts

Use one restricted LiteLLM caller key with distinct API contracts: native MiMo
Chat Completions for hardware extraction and the OpenRouter Decisions passthrough
for probabilistic classification. Preserve exact route names, source-quote
validation, bounded requests and conservative spend reservations. Environment
credentials take precedence over a private locally saved key. Model routes remain
explicit; the Decider V1.2 route replaces the withdrawn V1.1 route. Provider
availability or a syntactic probe does not establish marketplace-wide semantic
quality. Missing keys or failures fall back to conservative interpretation.

Follow-up accepted 24 October 2026: retain MiMo 2.6 Flash and use Xiaomi's
documented JSON-object mode. Supply the full validator-derived contract and an
example in the prompt; keep strict field and source-quote validation, including
rejection of zero capacities. Do not treat a proxy accepting `json_schema` as
evidence of upstream schema enforcement. Provider research is recorded in
[LLM settings](../llm-settings.md#mimo-structured-output-research--24-october-2026).

Allow at most one extra request per failed API stage for recoverable transport,
HTTP or output failures. Classification and extraction retain separate retry
limits, and successful classification is reused. All attempts consume the
original job allowance; uncertain charges retain their reservations. Preserve
per-request deadlines, cancellation, fatal billing/routing checks and the
existing repeated-failure fallback. Fix future runs without rewriting or
automatically replaying completed run history.
