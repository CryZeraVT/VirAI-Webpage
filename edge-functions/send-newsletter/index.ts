import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl     = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const resendApiKey    = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM_ADDRESS    = "AiRi <noreply@virflowsocial.com>";
const SITE_URL        = "https://viritts.com";

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

async function sendResendEmail(to: string, subject: string, html: string, text: string) {
  if (!resendApiKey) {
    console.warn("RESEND_API_KEY not set — skipping email");
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html, text }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("Resend error:", err);
    return { ok: false, error: err };
  }
  return { ok: true };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Verify caller is an admin
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase   = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single();

  if (!profile?.is_admin) return jsonResponse({ error: "Admin access required" }, 403);

  // Parse body
  let subject: string, body: string;
  try {
    const payload = await req.json();
    subject = String(payload.subject ?? "").trim();
    body    = String(payload.body    ?? "").trim();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (!subject || !body) {
    return jsonResponse({ error: "subject and body are required" }, 400);
  }

  // Fetch subscribed list
  const { data: subscribers, error: subError } = await supabase
    .from("mailing_list")
    .select("email, name")
    .eq("subscribed", true);

  if (subError) return jsonResponse({ error: subError.message }, 500);
  if (!subscribers || subscribers.length === 0) {
    return jsonResponse({ sent: 0, total: 0, message: "No active subscribers" });
  }

  const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="background:#0a0014;color:#e2e8f0;font-family:sans-serif;padding:32px;max-width:560px;margin:0 auto;">
  <h2 style="color:#a78bfa;margin-bottom:4px;">${subject}</h2>
  <hr style="border-color:#2d1b4e;margin:20px 0;">
  <div style="font-size:1rem;line-height:1.8;color:#d1d5db;">
    ${body.replace(/\n/g, "<br>")}
  </div>
  <hr style="border-color:#2d1b4e;margin:28px 0;">
  <p style="font-size:0.8em;color:#4b5563;margin:0;">
    You're receiving this because you signed up at <a href="${SITE_URL}" style="color:#7c3aed;">${SITE_URL}</a>.<br>
    — The AiRi Team
  </p>
</body>
</html>`;

  // Send to each subscriber
  let sent = 0;
  const errors: string[] = [];

  for (const sub of subscribers) {
    const result = await sendResendEmail(sub.email, subject, htmlBody, body);
    if (result.ok) {
      sent++;
    } else {
      errors.push(`${sub.email}: ${result.error}`);
    }
  }

  return jsonResponse({
    sent,
    total: subscribers.length,
    errors: errors.length ? errors : undefined,
  });
});
