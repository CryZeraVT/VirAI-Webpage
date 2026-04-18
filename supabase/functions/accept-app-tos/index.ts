// Records that the holder of a given license (on a given machine) has accepted
// a specific version of the in-app Terms of Service / EULA.
//
// Security model: no Supabase user session exists in the desktop app, so we
// authenticate via license_key + machine_id the same way validate-license does.
// If the license is already bound to a DIFFERENT machine, the call is rejected
// (prevents a stolen license key from being used to record acceptance).
//
// Aegis: Tier 3 (legal/consent + touches licenses row).
//
// Request : { license_key, machine_id, tos_version }
// Response: { ok: true, tos_version, tos_accepted_at }
//         | { ok: false, message: string }  (non-2xx for hard errors)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl    = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(supabaseUrl, serviceRoleKey);

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getCurrentTosVersion(): Promise<string> {
  const { data } = await supabase
    .from("site_settings")
    .select("value")
    .eq("key", "app_tos_current_version")
    .maybeSingle();
  return data?.value ?? "";
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, message: "Method not allowed." }, 405);
  }

  const payload = await req.json().catch(() => null);
  if (!payload) return jsonResponse({ ok: false, message: "Invalid JSON body." }, 400);

  const licenseKey = String(payload.license_key ?? "").trim();
  const machineId  = String(payload.machine_id  ?? "").trim();
  const tosVersion = String(payload.tos_version ?? "").trim();

  if (!licenseKey) return jsonResponse({ ok: false, message: "Missing license_key." }, 400);
  if (!machineId)  return jsonResponse({ ok: false, message: "Missing machine_id." }, 400);
  if (!tosVersion) return jsonResponse({ ok: false, message: "Missing tos_version." }, 400);

  // Fetch the license row using the service role.
  const { data: lic, error: licErr } = await supabase
    .from("licenses")
    .select("license_key,status,expires_at,machine_id")
    .eq("license_key", licenseKey)
    .single();

  if (licErr || !lic) {
    return jsonResponse({ ok: false, message: "License key not found." }, 404);
  }
  if (lic.status !== "active") {
    return jsonResponse({ ok: false, message: "License is inactive." }, 403);
  }
  if (lic.expires_at) {
    const expiresAt = new Date(lic.expires_at);
    if (expiresAt.getTime() < Date.now()) {
      return jsonResponse({ ok: false, message: "License expired." }, 403);
    }
  }

  // Machine-binding enforcement — reuses the same rule as validate-license.
  // If the license is already bound to a different machine, reject.
  // If not yet bound, binding happens on validate-license first; we don't bind here.
  if (lic.machine_id && lic.machine_id !== machineId) {
    return jsonResponse(
      { ok: false, message: "License is bound to another machine." },
      403,
    );
  }

  // Prevent accepting an unknown/future version: must match what site_settings advertises.
  const currentVersion = await getCurrentTosVersion();
  if (currentVersion && tosVersion !== currentVersion) {
    return jsonResponse(
      { ok: false, message: `ToS version mismatch (server: ${currentVersion}).` },
      409,
    );
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("licenses")
    .update({
      tos_version:             tosVersion,
      tos_accepted_at:         nowIso,
      tos_accepted_machine_id: machineId,
    })
    .eq("license_key", licenseKey);

  if (updErr) {
    console.error("accept-app-tos update error:", updErr);
    return jsonResponse({ ok: false, message: "Could not record acceptance." }, 500);
  }

  return jsonResponse({ ok: true, tos_version: tosVersion, tos_accepted_at: nowIso });
});
