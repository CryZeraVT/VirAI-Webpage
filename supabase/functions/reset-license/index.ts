import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(supabaseUrl, serviceRoleKey);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, message: "Method not allowed." }, 405);
  }

  // Get user from Auth header
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ success: false, message: "Missing Authorization header." }, 401);
  }

  const { data: { user }, error: userError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
  if (userError || !user) {
    return jsonResponse({ success: false, message: "Unauthorized." }, 401);
  }

  const payload = await req.json().catch(() => null);
  if (!payload || !payload.license_key) {
    return jsonResponse({ success: false, message: "Missing license_key." }, 400);
  }

  const licenseKey = String(payload.license_key).trim();

  // Verify ownership and reset machine_id
  const { data, error } = await supabase
    .from("licenses")
    .update({ machine_id: null, status: 'active', last_seen: null })
    .eq("license_key", licenseKey)
    .eq("email", user.email) // Ensure user owns this license
    .select();

  if (error) {
    console.error("Reset error:", error);
    return jsonResponse({ success: false, message: "Failed to reset license." }, 500);
  }

  if (!data || data.length === 0) {
    return jsonResponse({ success: false, message: "License not found or not owned by you." }, 404);
  }

  return jsonResponse({
    success: true,
    message: "License reset successfully. You can now activate it on a new machine.",
  });
});
