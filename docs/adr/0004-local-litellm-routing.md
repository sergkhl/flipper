# Separate LiteLLM extraction and Decisions contracts

Use one restricted LiteLLM caller key with distinct API contracts: native MiMo
Chat Completions for hardware extraction and the OpenRouter Decisions passthrough
for probabilistic classification. Preserve exact route names, source-quote
validation, bounded requests and conservative spend reservations. Environment
credentials take precedence over a private locally saved key. Model routes remain
explicit; the Decider V1.2 route replaces the withdrawn V1.1 route. Provider
availability or a syntactic probe does not establish marketplace-wide semantic
quality. Missing keys or failures fall back to conservative interpretation.
