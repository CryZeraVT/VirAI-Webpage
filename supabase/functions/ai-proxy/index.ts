// verify_jwt: false — auth is handled via license_key validation below
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Parse request body first so we can read license_key
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

  // Auth: require a license_key — this is the desktop app's proof of subscription
  if (!license_key || typeof license_key !== "string" || !license_key.trim()) {
    return jsonResponse({ error: "license_key is required" }, 401);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Validate license
  const { data: license, error: licError } = await supabase
    .from("licenses")
    .select("status, expires_at")
    .eq("license_key", license_key.trim())
    .single();

  if (licError || !license) {
    return jsonResponse({ error: "License not found" }, 403);
  }
  if (license.status !== "active") {
    return jsonResponse({ error: "License is inactive" }, 403);
  }
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return jsonResponse({ error: "License has expired" }, 403);
  }

  // Read AI provider config
  const { data: aiConfig } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", "builtin_ai_provider")
    .maybeSingle();

  const provider: string = (aiConfig?.value as Record<string, string>)?.provider ?? "openai";
  const model: string = (aiConfig?.value as Record<string, string>)?.model ?? "gpt-4o-mini";

  // Read API keys (only accessible by service_role — RLS blocks public read)
  const { data: apiKeysConfig } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", "ai_api_keys")
    .maybeSingle();

  const apiKey: string | undefined = (apiKeysConfig?.value as Record<string, string>)?.[provider];

  if (!apiKey) {
    return jsonResponse({ error: `No API key configured for provider: ${provider}` }, 503);
  }

  // Route to the correct AI provider
  let apiUrl: string;
  const aiHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };

  if (provider === "openai") {
    apiUrl = "https://api.openai.com/v1/chat/completions";
  } else if (provider === "grok") {
    apiUrl = "https://api.x.ai/v1/chat/completions";
  } else {
    return jsonResponse({ error: `Unknown provider: ${provider}` }, 400);
  }

  const aiRes = await fetch(apiUrl, {
    method: "POST",
    headers: aiHeaders,
    body: JSON.stringify({ model, messages }),
  });

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    return jsonResponse({ error: `AI provider error (${aiRes.status}): ${errText}` }, aiRes.status);
  }

  const aiData = await aiRes.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  // Track token usage if we have a license key
  if (license_key && aiData.usage) {
    const { prompt_tokens, completion_tokens } = aiData.usage;

    const { data: pricing } = await supabase
      .from("model_pricing")
      .select("input_cost_per_million, output_cost_per_million")
      .eq("provider", provider)
      .eq("model", model)
      .maybeSingle();

    const pricingRow = pricing as { input_cost_per_million: number; output_cost_per_million: number } | null;
    const inputCost = pricingRow ? (prompt_tokens / 1_000_000) * Number(pricingRow.input_cost_per_million) : 0;
    const outputCost = pricingRow ? (completion_tokens / 1_000_000) * Number(pricingRow.output_cost_per_million) : 0;

    await supabase.from("token_usage").insert({
      license_key,
      provider,
      model,
      prompt_tokens,
      completion_tokens,
      cost_usd: inputCost + outputCost,
      twitch_channel: twitch_channel ?? null,
    });
  }

  return jsonResponse({
    content: aiData.choices?.[0]?.message?.content ?? "",
    usage: aiData.usage ?? null,
    model,
    provider,
  });
});
