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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return jsonResponse({ error: "Method not allowed" }, 405);

  let body: { license_key?: string };
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const licenseKey = body.license_key?.trim();
  if (!licenseKey) return jsonResponse({ error: "license_key is required" }, 401);

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: license, error: licErr } = await supabase
    .from("licenses")
    .select("status, expires_at, tier")
    .eq("license_key", licenseKey)
    .single();

  if (licErr || !license)        return jsonResponse({ error: "License not found" }, 403);
  if (license.status !== "active") return jsonResponse({ error: "License is inactive" }, 403);
  if (license.expires_at && new Date(license.expires_at) < new Date())
    return jsonResponse({ error: "License has expired" }, 403);

  if (license.tier === "beta") {
    return jsonResponse({ tier: "beta", unlimited: true });
  }

  const { data: quota } = await supabase
    .from("token_quotas")
    .select("tokens_used, boost_tokens_remaining, base_limit, period_start, period_end")
    .eq("license_key", licenseKey)
    .maybeSingle();

  const tokensUsed     = quota?.tokens_used ?? 0;
  const baseLimit      = quota?.base_limit ?? 2000000;
  const boostRemaining = quota?.boost_tokens_remaining ?? 0;
  const periodStart    = quota?.period_start ?? new Date().toISOString();
  const periodEnd      = quota?.period_end ?? new Date(Date.now() + 30 * 86400000).toISOString();

  const now = new Date();
  const daysRemaining = Math.max(0, Math.ceil((new Date(periodEnd).getTime() - now.getTime()) / 86400000));

  const { data: usageRows } = await supabase
    .from("token_usage")
    .select("prompt_tokens, completion_tokens, created_at")
    .eq("license_key", licenseKey)
    .gte("created_at", periodStart)
    .order("created_at", { ascending: true });

  let avgTokensPerHour = 0;
  let totalHoursTracked = 0;

  if (usageRows && usageRows.length > 0) {
    let totalTokens = 0;
    const activeHours = new Set<string>();

    for (const row of usageRows) {
      totalTokens += (row.prompt_tokens ?? 0) + (row.completion_tokens ?? 0);
      const d = new Date(row.created_at);
      activeHours.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`);
    }

    totalHoursTracked = activeHours.size;
    avgTokensPerHour = totalHoursTracked > 0
      ? Math.round(totalTokens / totalHoursTracked)
      : 0;
  }

  return jsonResponse({
    tier: license.tier ?? "standard",
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
