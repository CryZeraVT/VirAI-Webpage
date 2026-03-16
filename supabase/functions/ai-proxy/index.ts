// verify_jwt: false — auth is handled via license_key validation below
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl    = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

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

/** True for models that use reasoning budgets and don't accept temperature/top_p. */
function isReasoningModel(provider: string, model: string): boolean {
  const m = model.toLowerCase();
  if (provider === "grok" && m.includes("grok-4") && !m.includes("non-reasoning")) return true;
  if (provider === "openai" && (m.includes("gpt-5") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4"))) return true;
  return false;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: {
    messages?: unknown[];
    license_key?: string;
    twitch_channel?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonResponse({ error: "messages array is required" }, 400);
  }

  const { messages, license_key, twitch_channel } = body;

  if (!license_key || typeof license_key !== "string" || !license_key.trim()) {
    return jsonResponse({ error: "license_key is required" }, 401);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // ── Validate license ────────────────────────────────────────────────────────
  const { data: license, error: licError } = await supabase
    .from("licenses")
    .select("status, expires_at")
    .eq("license_key", license_key.trim())
    .single();

  if (licError || !license)        return jsonResponse({ error: "License not found" }, 403);
  if (license.status !== "active") return jsonResponse({ error: "License is inactive" }, 403);
  if (license.expires_at && new Date(license.expires_at) < new Date())
                                   return jsonResponse({ error: "License has expired" }, 403);

  // ── Read AI config (provider, model + optional generation params) ───────────
  const { data: aiConfig } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", "builtin_ai_provider")
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

  // ── Read API keys (service_role bypasses RLS) ───────────────────────────────
  const { data: apiKeysConfig } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", "ai_api_keys")
    .maybeSingle();

  const apiKey = (apiKeysConfig?.value as Record<string, string>)?.[provider];
  if (!apiKey) {
    return jsonResponse({ error: `No API key configured for provider: ${provider}` }, 503);
  }

  // ── Build request payload ───────────────────────────────────────────────────
  let apiUrl: string;
  if (provider === "openai")    apiUrl = "https://api.openai.com/v1/chat/completions";
  else if (provider === "grok") apiUrl = "https://api.x.ai/v1/chat/completions";
  else return jsonResponse({ error: `Unknown provider: ${provider}` }, 400);

  const aiPayload: Record<string, unknown> = { model, messages };

  if (reasoning) {
    // Reasoning models: only max_completion_tokens is safe
    aiPayload["max_completion_tokens"] = cfg.max_completion_tokens ?? 2000;
  } else {
    // Standard models: full param set
    aiPayload["temperature"]       = cfg.temperature       ?? 0.9;
    aiPayload["max_tokens"]        = cfg.max_tokens        ?? 300;
    aiPayload["top_p"]             = cfg.top_p             ?? 1.0;
    aiPayload["frequency_penalty"] = cfg.frequency_penalty ?? 0.3;
    aiPayload["presence_penalty"]  = cfg.presence_penalty  ?? 0.3;
  }

  // ── Call AI provider ────────────────────────────────────────────────────────
  const aiRes = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
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

  // ── Track token usage ───────────────────────────────────────────────────────
  if (aiData.usage) {
    const { prompt_tokens, completion_tokens } = aiData.usage;
    const { data: pricing } = await supabase
      .from("model_pricing")
      .select("input_cost_per_million, output_cost_per_million")
      .eq("provider", provider)
      .eq("model", model)
      .maybeSingle();

    type PricingRow = { input_cost_per_million: number; output_cost_per_million: number };
    const p = pricing as PricingRow | null;
    const cost = p
      ? (prompt_tokens     / 1_000_000) * Number(p.input_cost_per_million)
      + (completion_tokens / 1_000_000) * Number(p.output_cost_per_million)
      : 0;

    await supabase.from("token_usage").insert({
      license_key:    license_key.trim(),
      provider, model,
      prompt_tokens, completion_tokens,
      cost_usd:       cost,
      twitch_channel: twitch_channel ?? null,
    });
  }

  return jsonResponse({
    content:   aiData.choices?.[0]?.message?.content ?? "",
    usage:     aiData.usage ?? null,
    model, provider, reasoning,
  });
});
