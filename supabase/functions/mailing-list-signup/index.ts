import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl     = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const resendApiKey    = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM_ADDRESS    = Deno.env.get("FROM_ADDRESS") ?? "ViriTTS <noreply@virflowsocial.com>";
const SITE_URL        = "https://viritts.com";

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sendConfirmationEmail(to: string, name: string) {
  if (!resendApiKey) {
    console.warn("RESEND_API_KEY not set — skipping confirmation email");
    return;
  }

  const displayName = name || "there";
  const html = `
<!DOCTYPE html>
<html>
<body style="background:#0a0014;color:#e2e8f0;font-family:sans-serif;padding:32px;max-width:520px;margin:0 auto;">
  <h1 style="color:#a78bfa;margin-bottom:4px;">You're on the list!</h1>
  <p style="color:#9ca3af;margin-top:0;">ViriTTS Launch Notifications</p>
  <hr style="border-color:#2d1b4e;margin:20px 0;" />
  <p>Hey <strong>${displayName}</strong>,</p>
  <p>Thanks for signing up — you'll be the first to know when <strong>ViriTTS</strong> launches publicly.</p>
  <div style="background:#1a112e;border:1px solid #4c1d95;border-radius:10px;padding:20px;margin:20px 0;">
    <p style="margin:0;color:#a78bfa;font-weight:bold;">What happens next?</p>
    <ul style="color:#d1d5db;line-height:2;margin:10px 0 0;">
      <li>We'll email you the moment ViriTTS goes live</li>
      <li>You'll get early access pricing info</li>
      <li>No spam — just launch updates</li>
    </ul>
  </div>
  <p>In the meantime, check out what we're building at <a href="${SITE_URL}" style="color:#a78bfa;">${SITE_URL}</a></p>
  <hr style="border-color:#2d1b4e;margin:20px 0;" />
  <p style="font-size:0.8em;color:#4b5563;">
    Don't want these emails? <a href="${SITE_URL}/unsubscribe.html?email=${encodeURIComponent(to)}" style="color:#7c3aed;">Unsubscribe here</a>.
  </p>
</body>
</html>`;

  const text = [
    `Hey ${displayName},`,
    "",
    "Thanks for signing up — you'll be the first to know when ViriTTS launches publicly.",
    "",
    "What happens next:",
    "- We'll email you the moment ViriTTS goes live",
    "- You'll get early access pricing info",
    "- No spam — just launch updates",
    "",
    `Check out what we're building: ${SITE_URL}`,
    "",
    `To unsubscribe: ${SITE_URL}/unsubscribe.html?email=${encodeURIComponent(to)}`,
  ].join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [to],
      subject: "You're on the ViriTTS launch list!",
      html,
      text,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Resend error:", err);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
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

  const { email, name } = body;

  if (!email?.trim()) {
    return jsonResponse({ error: "Email is required." }, 400);
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return jsonResponse({ error: "Invalid email address." }, 400);
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanName  = name?.trim() || null;

  // Check for duplicate
  const { data: existing } = await supabase
    .from("mailing_list")
    .select("id, subscribed")
    .eq("email", cleanEmail)
    .maybeSingle();

  if (existing) {
    if (!existing.subscribed) {
      // Re-subscribe them silently
      await supabase
        .from("mailing_list")
        .update({ subscribed: true })
        .eq("email", cleanEmail);
    }
    // Return success either way — don't leak whether email exists
    return jsonResponse({ success: true, already_subscribed: true });
  }

  const { error: insertError } = await supabase.from("mailing_list").insert({
    email: cleanEmail,
    name: cleanName,
    subscribed: true,
    source: "website",
  });

  if (insertError) {
    console.error("Insert error:", insertError);
    return jsonResponse({ error: "Failed to subscribe. Please try again." }, 500);
  }

  await sendConfirmationEmail(cleanEmail, cleanName ?? "");

  return jsonResponse({ success: true });
});
