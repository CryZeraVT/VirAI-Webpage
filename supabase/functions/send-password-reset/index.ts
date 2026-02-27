import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";

const SITE_URL = "https://www.viritts.com";
const RESET_REDIRECT = `${SITE_URL}/account.html`;
const FROM_ADDRESS = "ViriTTS <noreply@virflowsocial.com>";

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

async function sendResendEmail(to: string, subject: string, html: string, text: string) {
  if (!resendApiKey) return { ok: false, error: "RESEND_API_KEY not configured" };
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

  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email) return jsonResponse({ error: "Email is required" }, 400);

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return jsonResponse({ error: "Invalid email address" }, 400);

  // Keep response generic for security; do not reveal user existence.
  let actionLink: string | null = null;
  try {
    const { data, error } = await supabase.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo: RESET_REDIRECT },
    });
    if (!error) actionLink = data?.properties?.action_link ?? null;
  } catch {
    // Intentionally swallowed for generic response behavior.
  }

  if (actionLink) {
    const htmlBody = `
<!DOCTYPE html>
<html>
<body style="background:#0a0014;color:#e2e8f0;font-family:sans-serif;padding:32px;max-width:560px;margin:0 auto;">
  <h1 style="color:#a78bfa;margin-bottom:6px;">Reset Your ViriTTS Password</h1>
  <p style="color:#9ca3af;margin-top:0;">We received a request to reset your password.</p>
  <hr style="border-color:#2d1b4e;margin:20px 0;" />
  <p>Click the button below to set a new password:</p>
  <div style="text-align:center;margin:28px 0;">
    <a href="${actionLink}" style="background:#7c3aed;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">
      Reset Password
    </a>
  </div>
  <p style="font-size:0.85em;color:#6b7280;">
    If the button does not work, copy this link:<br>
    <span style="word-break:break-all;">${actionLink}</span>
  </p>
  <hr style="border-color:#2d1b4e;margin:20px 0;" />
  <p style="font-size:0.8em;color:#4b5563;">
    If you did not request this, you can safely ignore this email.<br>
    — ViriTTS Team
  </p>
</body>
</html>`;

    const textBody = [
      "Reset Your ViriTTS Password",
      "",
      "Use this link to reset your password:",
      actionLink,
      "",
      "If you did not request this, you can ignore this email.",
    ].join("\n");

    await sendResendEmail(
      email,
      "Reset your ViriTTS password",
      htmlBody,
      textBody
    );
  }

  return jsonResponse({
    success: true,
    message: "If that email exists in our system, a reset link has been sent.",
  });
});
