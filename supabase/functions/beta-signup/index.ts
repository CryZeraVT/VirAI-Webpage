import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(supabaseUrl, serviceRoleKey);

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://viritts.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function consumeLimit(key: string): Promise<boolean | null> {
  const { data, error } = await supabase.rpc("consume_edge_rate_limit", {
    p_endpoint: "beta-signup:ip",
    p_key_hash: await sha256(key),
    p_limit: 5,
    p_window_seconds: 86400,
  });
  if (error) {
    console.error("beta-signup rate-limit check failed:", error.message);
    return null;
  }
  return data === true;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "Content-Type must be application/json." }, 415);
  }

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const { name, email, twitch_username, content_type, message } = body;

  if (!name?.trim() || !email?.trim() || !twitch_username?.trim()) {
    return jsonResponse({ error: "Name, email, and Twitch username are required." }, 400);
  }

  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  const cleanTwitch = twitch_username.trim();
  const cleanContentType = String(content_type || "").trim();
  const cleanMessage = String(message || "").trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleanEmail)) {
    return jsonResponse({ error: "Invalid email address." }, 400);
  }
  if (
    cleanName.length > 120 ||
    cleanEmail.length > 254 ||
    cleanTwitch.length > 80 ||
    cleanContentType.length > 120 ||
    cleanMessage.length > 2000
  ) {
    return jsonResponse({ error: "One or more fields exceed the allowed length." }, 400);
  }

  const forwarded = req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  const rateAllowed = await consumeLimit(forwarded);
  if (rateAllowed === null) {
    return jsonResponse({ error: "Signup service is temporarily unavailable." }, 503);
  }
  if (!rateAllowed) {
    return jsonResponse({ error: "Too many signup attempts. Please try again later." }, 429);
  }

  // Check for duplicate signup
  const { data: existing } = await supabase
    .from("beta_signups")
    .select("id")
    .eq("email", cleanEmail)
    .maybeSingle();

  if (existing) {
    return jsonResponse({ error: "This email is already on the beta list!" }, 409);
  }

  // Insert the signup — no auth invite or email sent here.
  // The invite email only fires when the admin clicks "Approve" in the dashboard,
  // which calls send-beta-approval. This avoids burning Supabase's 2/hour email limit.
  const { error: insertError } = await supabase.from("beta_signups").insert({
    name: cleanName,
    email: cleanEmail,
    twitch_username: cleanTwitch,
    content_type: cleanContentType || null,
    message: cleanMessage || null,
    status: "pending",
  });

  if (insertError) {
    console.error("Insert error:", insertError);
    return jsonResponse({ error: "Failed to save signup. Please try again." }, 500);
  }

  return jsonResponse({ success: true });
});
