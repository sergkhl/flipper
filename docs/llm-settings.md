# Optional model gateway

The server loads `.env` at startup. `LITELLM_API_KEY` takes precedence over an
administrator-saved `liteLlmKey` in mode-0600 `.data/secrets.json`. Keys are never
returned by the API. Restart after changing environment credentials or URLs.

`LITELLM_BASE_URL` accepts a chat base URL (default `http://localhost:4000/v1`)
or the full `/chat/completions` URL. `LITELLM_DECISIONS_URL` is a separate full
OpenRouter Decisions passthrough URL. Both authenticate using the same restricted
gateway caller key. A hosted container needs gateway URLs reachable on its
private network; localhost inside the container refers to the container itself.

Hardware extraction sends the exact LiteLLM route
`xiaomi_mimo/mimo-v2.6-flash` with strict JSON-schema output, bounded text and
output tokens, and disabled thinking through `extra_body`. Classification uses
`perplexity/pplx-decider-v1.2` on the dedicated Decisions state/questions API.
Do not prepend `openrouter/` to this Decisions model ID. Model availability needs
current gateway/provider verification; there is no silent model substitution.

Source-supported quotes are validated. AI never invents installed capacities,
market prices, comparisons or discounts. Caches include an assessment-contract
version. Missing keys, provider failures and exhausted budgets leave conservative
interpretation and fetched evidence available with explicit status.

Manual jobs use the editable manual AI budget. Scheduled jobs use at most USD
0.25 per category and USD 0.75 in admitted allowances per nominal Vietnam
schedule day. Reservations are made before requests; unknown billing consumes
the reservation. The full category allowance is persisted before a scheduled
attempt, so a crash cannot replenish it. A provider-reported overage seals that
job's AI budget and reduces later category admission. These are request-admission
limits, not a guarantee about an external provider's final bill. A long category
can finish after midnight; its reservation remains assigned to its schedule day.

Chat has a 120-second deadline; Decisions has 45 seconds. Cancellation and
shutdown propagate abort signals, retain conservative reservations, and drain
background finalization before SQLite closes. The explicit Test AI action uses
its own bounded manual budget and can incur provider charges.
