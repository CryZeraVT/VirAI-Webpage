# AI Proxy Failover + Admin Probe

## Chains (live)
- Core ($10 / standard / test): Gemini -> OpenAI -> Grok
- Studio ($20 / studio / beta): Grok -> OpenAI -> Gemini

Config: `system_config.ai_failover_chains` (admin AI Engine tab). Edge also has in-code fallbacks if the row is missing.

## Required secret (probe only)
Set on the `ai-proxy` Edge Function in Supabase Dashboard -> Edge Functions -> ai-proxy -> Secrets:

```
AIRI_ADMIN_PROBE_SECRET=<long random string>
```

CLI alternative (if logged in):

```
supabase secrets set AIRI_ADMIN_PROBE_SECRET="<long random string>" --project-ref rgigtqpesabuyaumibaj
```

Without this secret, `test_api_key` / `force_failover` / `chain_override` are ignored (normal clients unaffected).

## Admin probe
1. Open admin.html -> AI Engine
2. Save Failover Chains (models)
3. Failover Probe: paste secret + active license key
4. Check "Force hop 0 fail"
5. Run Failover Probe for Core then Studio
6. Confirm `failover_used=true` and winner is hop 1+

Optional: paste an ephemeral test API key for a specific provider; it is not saved to `ai_api_keys`.

## Happy path for users
Unchanged when primary is healthy. Failover only runs on retryable provider failures.
