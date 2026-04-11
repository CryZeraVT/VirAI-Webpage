// verify_jwt: false — auth is via license_key
// config_key selects which system_config row to use:
//   "builtin_ai_provider"  → legacy testers
//   "proxy_ai_provider"    → new prod users (default)
// max_tokens: optional per-request override (dynamic from persona word limit)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl    = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const ALLOWED_CONFIG_KEYS = ["builtin_ai_provider", "proxy_ai_provider"] as const;
type ConfigKey = typeof ALLOWED_CONFIG_KEYS[number];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function isReasoningModel(provider: string, model: string): boolean {
  const m = model.toLowerCase();
  if (provider === "grok" && m.includes("grok-4") && !m.includes("non-reasoning")) return true;
  if (provider === "openai" && (m.includes("gpt-5") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4"))) return true;
  return false;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return jsonResponse({ error: "Method not allowed" }, 405);

  let body: {
    messages?:       unknown[];
    license_key?:    string;
    twitch_channel?: string;
    config_key?:     string;
    max_tokens?:     number;
  };
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0)
    return jsonResponse({ error: "messages array is required" }, 400);

  const { messages, license_key, twitch_channel } = body;

  const rawKey = (body.config_key ?? "proxy_ai_provider").trim();
  const configKey: ConfigKey = (ALLOWED_CONFIG_KEYS as readonly string[]).includes(rawKey)
    ? rawKey as ConfigKey
    : "proxy_ai_provider";

  const requestMaxTokens = (typeof body.max_tokens === "number" && body.max_tokens > 0)
    ? Math.min(body.max_tokens, 2000)
    : null;

  if (!license_key?.trim())
    return jsonResponse({ error: "license_key is required" }, 401);

  const trimmedKey = license_key.trim();
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // ── Validate license + read tier ──────────────────────────────────────────
  const { data: license, error: licError } = await supabase
    .from("licenses")
    .select("status, expires_at, tier")
    .eq("license_key", trimmedKey)
    .single();

  if (licError || !license)        return jsonResponse({ error: "License not found" }, 403);
  if (license.status !== "active") return jsonResponse({ error: "License is inactive" }, 403);
  if (license.expires_at && new Date(license.expires_at) < new Date())
    return jsonResponse({ error: "License has expired" }, 403);

  const isBeta = license.tier === "beta";

  // ── Quota pre-check (standard tier only) ──────────────────────────────────
  if (!isBeta) {
    const { data: quota } = await supabase
      .from("token_quotas")
      .select("tokens_used, boost_tokens_remaining, base_limit, period_end")
      .eq("license_key", trimmedKey)
      .maybeSingle();

    if (quota) {
      const periodExpired = new Date(quota.period_end) <= new Date();
      const baseExhausted = quota.tokens_used >= quota.base_limit;
      const boostEmpty    = quota.boost_tokens_remaining <= 0;

      if (!periodExpired && baseExhausted && boostEmpty) {
        return jsonResponse({
          error: "quota_exceeded",
          quota_blocked: true,
          tokens_used: quota.tokens_used,
          base_limit: quota.base_limit,
          quota_percent: 100,
          boost_remaining: 0,
          tier: "standard",
        }, 429);
      }
    }
  }

  // ── Read AI config ────────────────────────────────────────────────────────
  const { data: aiConfig } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", configKey)
    .maybeSingle();

  type AiCfg = {
    provider?: string; model?: string;
    temperature?: number; max_tokens?: number; max_completion_tokens?: number;
    top_p?: number; frequency_penalty?: number; presence_penalty?: number;
  };
  const cfg = (aiConfig?.value ?? {}) as AiCfg;

  const provider  = (cfg.provider ?? "openai").toLowerCase();
  const model     = cfg.model ?? "gpt-4o-mini";
  const reasoning = isReasoningModel(provider, model);

  // ── Read API keys ─────────────────────────────────────────────────────────
  const { data: apiKeysConfig } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", "ai_api_keys")
    .maybeSingle();

  const apiKey = (apiKeysConfig?.value as Record<string, string>)?.[provider];
  if (!apiKey)
    return jsonResponse({ error: `No API key configured for provider: ${provider}` }, 503);

  // ── Build AI payload ──────────────────────────────────────────────────────
  let apiUrl: string;
  if (provider === "openai")    apiUrl = "https://api.openai.com/v1/chat/completions";
  else if (provider === "grok") apiUrl = "https://api.x.ai/v1/chat/completions";
  else return jsonResponse({ error: `Unknown provider: ${provider}` }, 400);

  const aiPayload: Record<string, unknown> = { model, messages };

  if (reasoning) {
    aiPayload["max_completion_tokens"] = cfg.max_completion_tokens ?? 2000;
  } else if (provider === "grok") {
    aiPayload["temperature"] = cfg.temperature ?? 0.9;
    aiPayload["max_tokens"]  = requestMaxTokens ?? cfg.max_tokens ?? 300;
    aiPayload["top_p"]       = cfg.top_p       ?? 0.95;
  } else {
    aiPayload["temperature"]       = cfg.temperature       ?? 0.9;
    aiPayload["max_tokens"]        = requestMaxTokens ?? cfg.max_tokens ?? 300;
    aiPayload["top_p"]             = cfg.top_p             ?? 1.0;
    aiPayload["frequency_penalty"] = cfg.frequency_penalty ?? 0.3;
    aiPayload["presence_penalty"]  = cfg.presence_penalty  ?? 0.3;
  }

  // ── Call provider ─────────────────────────────────────────────────────────
  const aiRes = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(aiPayload),
  });

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    return jsonResponse({ error: `AI provider error (${aiRes.status}): ${errText}` }, aiRes.status);
  }

  const aiData = await aiRes.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?:   { prompt_tokens: number; completion_tokens: number };
  };

  // ── Track usage (always, for analytics) ────────────────────────────────────
  const promptTokens     = aiData.usage?.prompt_tokens ?? 0;
  const completionTokens = aiData.usage?.completion_tokens ?? 0;
  const totalTokens      = promptTokens + completionTokens;

  if (aiData.usage) {
    const { data: pricing } = await supabase
      .from("model_pricing")
      .select("input_cost_per_million, output_cost_per_million")
      .eq("provider", provider).eq("model", model)
      .maybeSingle();

    type P = { input_cost_per_million: number; output_cost_per_million: number };
    const pr = pricing as P | null;
    const cost = pr
      ? (promptTokens     / 1_000_000) * Number(pr.input_cost_per_million)
      + (completionTokens / 1_000_000) * Number(pr.output_cost_per_million)
      : 0;

    await supabase.from("token_usage").insert({
      license_key: trimmedKey,
      provider, model, prompt_tokens: promptTokens, completion_tokens: completionTokens,
      cost_usd: cost,
      twitch_channel: twitch_channel ?? null,
    });
  }

  // ── Quota post-increment (standard tier only) ─────────────────────────────
  let quotaInfo: Record<string, unknown> = {};

  if (!isBeta && totalTokens > 0) {
    const { data: quotaResult, error: rpcErr } = await supabase.rpc("increment_token_quota", {
      p_license_key: trimmedKey,
      p_tokens: totalTokens,
      p_license_active: license.status === "active",
    });

    if (!rpcErr && quotaResult) {
      quotaInfo = {
        tier: "standard",
        quota_used:      quotaResult.tokens_used,
        quota_limit:     quotaResult.base_limit,
        quota_percent:   quotaResult.quota_percent,
        quota_blocked:   !quotaResult.allowed,
        using_boost:     quotaResult.using_boost,
        boost_remaining: quotaResult.boost_remaining,
      };
    }
  } else if (isBeta) {
    quotaInfo = { tier: "beta" };
  }

  return jsonResponse({
    content:    aiData.choices?.[0]?.message?.content ?? "",
    usage:      aiData.usage ?? null,
    model, provider, reasoning, config_key: configKey,
    ...quotaInfo,
  });
});
