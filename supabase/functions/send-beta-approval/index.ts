import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
const SITE_URL = "https://viritts.com";
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

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function requireAdmin(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]?.trim()) {
    return { error: jsonResponse({ error: "Missing Authorization header." }, 401) };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(match[1].trim());
  if (userError || !userData?.user) {
    return { error: jsonResponse({ error: "Invalid or expired session." }, 401) };
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileError) {
    console.error("send-beta-approval admin check failed:", profileError.message);
    return { error: jsonResponse({ error: "Could not verify admin access." }, 500) };
  }
  if (!profile?.is_admin) {
    return { error: jsonResponse({ error: "Admin access required." }, 403) };
  }
  return { user: userData.user };
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

async function userExistsByEmail(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  const pageSize = 200;
  let page = 1;
  while (page <= 20) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: pageSize });
    if (error) break;
    const users = data?.users ?? [];
    if (users.some((u) => (u.email ?? "").toLowerCase() === normalized)) return true;
    if (users.length < pageSize) break;
    page += 1;
  }
  return false;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const admin = await requireAdmin(req);
  if ("error" in admin) return admin.error;

  let body: { name: string; email: string; license_key: string; expires_at: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const { name, email, license_key, expires_at } = body;

  if (!name?.trim() || !email?.trim() || !license_key?.trim()) {
    return jsonResponse({ error: "name, email, and license_key are required." }, 400);
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name.trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleanEmail)) {
    return jsonResponse({ error: "Invalid email address." }, 400);
  }
  if (cleanName.length > 120 || license_key.trim().length > 120) {
    return jsonResponse({ error: "Input exceeds the allowed length." }, 400);
  }
  const expiryDate = expires_at ? new Date(expires_at) : null;
  const expiryStr = expiryDate && Number.isFinite(expiryDate.getTime())
    ? expiryDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : "30 days from now";
  const safeName = escapeHtml(cleanName);
  const safeLicenseKey = escapeHtml(license_key.trim());
  const safeExpiry = escapeHtml(expiryStr);

  const alreadyExists = await userExistsByEmail(cleanEmail);

  let actionLink: string | null = null;
  let inviteError: string | null = null;

  if (alreadyExists) {
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: "magiclink",
      email: cleanEmail,
      options: { redirectTo: `${SITE_URL}/account.html` },
    });
    if (linkErr) {
      console.error("generateLink error:", linkErr.message);
      inviteError = linkErr.message;
    } else {
      actionLink = linkData?.properties?.action_link ?? null;
    }
  } else {
    const { data: inviteData, error: invErr } = await supabase.auth.admin.inviteUserByEmail(
      cleanEmail,
      { redirectTo: `${SITE_URL}/account.html` }
    );
    if (invErr) {
      console.error("inviteUserByEmail error:", invErr.message);
      inviteError = invErr.message;
    } else {
      actionLink = inviteData?.user?.action_link ?? null;
    }
  }

  const signInLine = actionLink
    ? `<a href="${escapeHtml(actionLink)}" style="background:#7c3aed;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;margin:12px 0;">
        ${alreadyExists ? "Sign In to Your Account" : "Create Your Account"}
       </a>`
    : `<a href="${SITE_URL}/account.html" style="background:#7c3aed;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;margin:12px 0;">
        Go to Account Page
       </a>`;

  const htmlBody = `
<!DOCTYPE html>
<html>
<body style="background:#0a0014;color:#e2e8f0;font-family:sans-serif;padding:32px;max-width:560px;margin:0 auto;">
  <h1 style="color:#a78bfa;margin-bottom:4px;">🎉 You're In!</h1>
  <p style="color:#9ca3af;margin-top:0;">Your ViriTTS Beta access has been approved.</p>
  <hr style="border-color:#2d1b4e;margin:20px 0;" />
  <p>Hey <strong>${safeName}</strong>,</p>
  <p>We've reviewed your application and you're officially approved for the <strong>ViriTTS Beta</strong>! Here's everything you need to get started:</p>

  <div style="background:#1a112e;border:1px solid #4c1d95;border-radius:10px;padding:20px;margin:20px 0;">
    <p style="margin:0 0 6px;color:#9ca3af;font-size:0.85em;">YOUR LICENSE KEY</p>
    <p style="margin:0;font-size:1.4em;font-weight:bold;letter-spacing:2px;color:#a78bfa;">${safeLicenseKey}</p>
    <p style="margin:8px 0 0;font-size:0.8em;color:#6b7280;">Expires: ${safeExpiry}</p>
  </div>

  <p><strong>How to activate:</strong></p>
  <ol style="color:#d1d5db;line-height:1.8;">
    <li>Sign in (or create your account) using the button below</li>
    <li>Download ViriTTS from <a href="${SITE_URL}" style="color:#a78bfa;">${SITE_URL}</a></li>
    <li>Open ViriTTS and enter your license key when prompted</li>
  </ol>

  <div style="text-align:center;margin:28px 0;">
    ${signInLine}
  </div>

  <p style="font-size:0.85em;color:#6b7280;">
    If the button doesn't work, copy this link:<br>
    <span style="word-break:break-all;">${escapeHtml(actionLink ?? `${SITE_URL}/account.html`)}</span>
  </p>

  <hr style="border-color:#2d1b4e;margin:20px 0;" />
  <p style="font-size:0.8em;color:#4b5563;">
    Questions? Reach out to us anytime.<br>
    — The ViriTTS Team<br>
    <a href="${SITE_URL}" style="color:#7c3aed;">${SITE_URL}</a>
  </p>
</body>
</html>`;

  const textBody = [
    `Hey ${cleanName},`,
    "",
    "You're officially approved for the ViriTTS Beta!",
    "",
    `YOUR LICENSE KEY: ${license_key}`,
    `Expires: ${expiryStr}`,
    "",
    "How to activate:",
    "1. Sign in or create your account: " + (actionLink ?? `${SITE_URL}/account.html`),
    "2. Download ViriTTS from " + SITE_URL,
    "3. Open ViriTTS and enter your license key when prompted",
    "",
    "— The ViriTTS Team",
    SITE_URL,
  ].join("\n");

  const emailResult = await sendResendEmail(
    cleanEmail,
    "🎉 You're Approved for ViriTTS Beta!",
    htmlBody,
    textBody
  );

  if (!emailResult.ok) {
    return jsonResponse({
      success: false,
      already_exists: alreadyExists,
      error: `Email failed to send: ${emailResult.error}`,
      invite_error: inviteError,
    }, 500);
  }

  return jsonResponse({
    success: true,
    already_exists: alreadyExists,
    invite_error: inviteError ?? null,
    expires: expiryStr,
  });
});
