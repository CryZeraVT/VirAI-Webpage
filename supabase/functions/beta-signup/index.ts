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
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
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

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return jsonResponse({ error: "Invalid email address." }, 400);
  }

  // Check for duplicate signup
  const { data: existing } = await supabase
    .from("beta_signups")
    .select("id")
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();

  if (existing) {
    return jsonResponse({ error: "This email is already on the beta list!" }, 409);
  }

  // Insert the signup — no auth invite or email sent here.
  // The invite email only fires when the admin clicks "Approve" in the dashboard,
  // which calls send-beta-approval. This avoids burning Supabase's 2/hour email limit.
  const { error: insertError } = await supabase.from("beta_signups").insert({
    name: name.trim(),
    email: email.trim().toLowerCase(),
    twitch_username: twitch_username.trim(),
    content_type: content_type || null,
    message: message?.trim() || null,
    status: "pending",
  });

  if (insertError) {
    console.error("Insert error:", insertError);
    return jsonResponse({ error: "Failed to save signup. Please try again." }, 500);
  }

  return jsonResponse({ success: true });
});
