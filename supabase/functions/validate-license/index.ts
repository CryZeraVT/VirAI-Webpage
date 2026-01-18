import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(supabaseUrl, serviceRoleKey);

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ valid: false, message: "Method not allowed." }, 405);
  }

  const payload = await req.json().catch(() => null);
  if (!payload || !payload.license_key) {
    return jsonResponse({ valid: false, message: "Missing license_key." }, 400);
  }

  const licenseKey = String(payload.license_key).trim();
  const machineId = payload.machine_id ? String(payload.machine_id).trim() : "";

  const { data, error } = await supabase
    .from("licenses")
    .select("license_key,status,expires_at,machine_id")
    .eq("license_key", licenseKey)
    .single();

  if (error || !data) {
    return jsonResponse({ valid: false, message: "License key not found." }, 200);
  }

  if (data.status !== "active") {
    return jsonResponse({ valid: false, message: "License is inactive." }, 200);
  }

  if (data.expires_at) {
    const expiresAt = new Date(data.expires_at);
    if (expiresAt.getTime() < Date.now()) {
      return jsonResponse({ valid: false, message: "License expired." }, 200);
    }
  }

  if (data.machine_id && machineId && data.machine_id !== machineId) {
    return jsonResponse(
      { valid: false, message: "License is already in use on another machine." },
      200,
    );
  }

  // Bind machine_id if first activation, and update last_seen
  const updates: Record<string, string | null> = {
    last_seen: new Date().toISOString(),
  };
  if (!data.machine_id && machineId) {
    updates.machine_id = machineId;
  }

  await supabase.from("licenses").update(updates).eq("license_key", licenseKey);

  return jsonResponse({
    valid: true,
    message: "License activated.",
    expires_at: data.expires_at ?? null,
  });
});
