// verify_jwt: false — auth is via license_key
//
// Returns quota status for the account page. Reads tier→token limits
// from system_config (key='tier_limits') with a 60s in-memory cache.
// Fallback to TIER_LIMITS_FALLBACK if the row is missing/malformed.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl    = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Keep in sync with ai-proxy and the DB seed in tier_limits_system_config.
const TIER_LIMITS_FALLBACK: Record<string, number> = {
  standard: 3_000_000,
  test:     50_000,
};

let TIER_LIMITS_CACHE: Record<string, number> = { ...TIER_LIMITS_FALLBACK };
let TIER_LIMITS_CACHE_AT = 0;
const TIER_CACHE_TTL_MS = 60_000;

async function getTierLimits(sb: SupabaseClient): Promise<Record<string, number>> {
  const now = Date.now();
  if (now - TIER_LIMITS_CACHE_AT < TIER_CACHE_TTL_MS) return TIER_LIMITS_CACHE;
  try {
    const { data, error } = await sb
      .from("system_config")
      .select("value")
      .eq("key", "tier_limits")
      .maybeSingle();
    if (error) throw error;
    if (data?.value && typeof data.value === "object") {
      const parsed: Record<string, number> = {};
      for (const [k, v] of Object.entries(data.value as Record<string, unknown>)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) parsed[k] = n;
      }
      if (Object.keys(parsed).length > 0) {
        TIER_LIMITS_CACHE = parsed;
        TIER_LIMITS_CACHE_AT = now;
      }
    }
  } catch (e) {
    console.error("tier_limits read failed, using cached/default:", e);
  }
  return TIER_LIMITS_CACHE;
}

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
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return jsonResponse({ error: "Method not allowed" }, 405);

  let body: {
    license_key?: string;
    machine_id?: string;
    client?: string;
    client_version?: string;
  };
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const licenseKey = body.license_key?.trim();
  if (!licenseKey) return jsonResponse({ error: "license_key is required" }, 401);

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Validate license + read tier
  const { data: license, error: licErr } = await supabase
    .from("licenses")
    .select("status, expires_at, tier, machine_id")
    .eq("license_key", licenseKey)
    .single();

  if (licErr || !license)          return jsonResponse({ error: "License not found" }, 403);
  if (license.status !== "active") return jsonResponse({ error: "License is inactive" }, 403);
  const machineId = String(body.machine_id || "").trim();
  const likelyDesktop = body.client === "airi-desktop" ||
    /python-requests/i.test(req.headers.get("user-agent") || "");
  if (likelyDesktop && !machineId) {
    const clientVersion = String(body.client_version || "unknown")
      .replace(/[^A-Za-z0-9._+-]/g, "")
      .slice(0, 40) || "unknown";
    console.warn(JSON.stringify({
      event: "compat_missing_machine_id",
      endpoint: "get-quota",
      client_version: clientVersion,
    }));
  }
  if (machineId && license.machine_id && license.machine_id !== machineId) {
    return jsonResponse({ error: "License is already in use on another machine." }, 403);
  }
  if (license.expires_at && new Date(license.expires_at) < new Date())
    return jsonResponse({ error: "License has expired" }, 403);

  if (license.tier === "beta") {
    return jsonResponse({ tier: "beta", unlimited: true });
  }

  const tier = (license.tier ?? "standard") as string;

  // Dynamic tier limit with 60s cache. Used as fallback when no
  // token_quotas row exists yet (customer hasn't made their first
  // AI call). Once they do, ai-proxy upserts base_limit into the
  // row and this fallback is no longer consulted.
  const tierLimits    = await getTierLimits(supabase);
  const tierFallback  = tierLimits[tier] ?? tierLimits.standard ?? TIER_LIMITS_FALLBACK.standard;

  // Read quota state
  const { data: quota } = await supabase
    .from("token_quotas")
    .select("tokens_used, boost_tokens_remaining, base_limit, period_start, period_end")
    .eq("license_key", licenseKey)
    .maybeSingle();

  const tokensUsed     = quota?.tokens_used ?? 0;
  const baseLimit      = quota?.base_limit ?? tierFallback;
  const boostRemaining = quota?.boost_tokens_remaining ?? 0;
  const periodStart    = quota?.period_start ?? new Date().toISOString();
  const periodEnd      = quota?.period_end ?? new Date(Date.now() + 30 * 86400000).toISOString();

  const now = new Date();
  const daysRemaining = Math.max(0, Math.ceil((new Date(periodEnd).getTime() - now.getTime()) / 86400000));

  // Avg from the quota row — do not scan token_usage. Same JSON fields so
  // current desktop builds keep working. Hours = elapsed period time (min 1).
  const hoursElapsed = Math.max(
    1,
    (now.getTime() - new Date(periodStart).getTime()) / 3_600_000,
  );
  const totalHoursTracked = Math.floor(hoursElapsed);
  const avgTokensPerHour = tokensUsed > 0
    ? Math.round(tokensUsed / hoursElapsed)
    : 0;

  return jsonResponse({
    tier,
    tokens_used: tokensUsed,
    base_limit: baseLimit,
    boost_remaining: boostRemaining,
    period_start: periodStart,
    period_end: periodEnd,
    days_remaining: daysRemaining,
    avg_tokens_per_hour: avgTokensPerHour,
    total_hours_tracked: totalHoursTracked,
  });
});
