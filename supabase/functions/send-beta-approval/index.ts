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

function generateTempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const special = "!@#$%&*";
  let password = "";
  for (let i = 0; i < 10; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  password += special.charAt(Math.floor(Math.random() * special.length));
  password += Math.floor(Math.random() * 90 + 10);
  return password;
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

async function findUserByEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  const pageSize = 200;
  let page = 1;
  while (page <= 20) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: pageSize });
    if (error) break;
    const users = data?.users ?? [];
    const found = users.find((u) => (u.email ?? "").toLowerCase() === normalized);
    if (found) return found;
    if (users.length < pageSize) break;
    page += 1;
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

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
  const expiryStr = expires_at
    ? new Date(expires_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : "30 days from now";

  const existingUser = await findUserByEmail(cleanEmail);

  let tempPassword: string | null = null;
  let signInMethod: "password" | "magic_link" = "password";
  let actionLink: string | null = null;
  let createError: string | null = null;

  if (existingUser) {
    // Existing user: generate magic link so they can sign in directly
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: "magiclink",
      email: cleanEmail,
      options: { redirectTo: `${SITE_URL}/account.html` },
    });
    if (linkErr) {
      console.error("generateLink error:", linkErr.message);
      createError = linkErr.message;
    } else {
      actionLink = linkData?.properties?.action_link ?? null;
      signInMethod = "magic_link";
    }
  } else {
    // New user: create with a temp password so they can sign in immediately
    tempPassword = generateTempPassword();
    const { data: createData, error: createErr } = await supabase.auth.admin.createUser({
      email: cleanEmail,
      password: tempPassword,
      email_confirm: true,
    });

    if (createErr) {
      console.error("createUser error:", createErr.message);
      createError = createErr.message;
      tempPassword = null;
    } else {
      // Generate a magic link as a fallback sign-in option
      const { data: linkData } = await supabase.auth.admin.generateLink({
        type: "magiclink",
        email: cleanEmail,
        options: { redirectTo: `${SITE_URL}/account.html` },
      });
      actionLink = linkData?.properties?.action_link ?? null;
    }
  }

  // Build the sign-in section of the email
  let signInBlock: string;
  let signInText: string;

  if (tempPassword) {
    // New user with temp password
    signInBlock = `
      <div style="background:#1a112e;border:1px solid #4c1d95;border-radius:10px;padding:20px;margin:20px 0;">
        <p style="margin:0 0 6px;color:#9ca3af;font-size:0.85em;">YOUR TEMPORARY PASSWORD</p>
        <p style="margin:0;font-size:1.2em;font-weight:bold;letter-spacing:1px;color:#06b6d4;font-family:monospace;">${tempPassword}</p>
        <p style="margin:8px 0 0;font-size:0.8em;color:#f59e0b;">⚠️ Please change this after your first sign-in.</p>
      </div>
      <p><strong>How to sign in:</strong></p>
      <ol style="color:#d1d5db;line-height:1.8;">
        <li>Go to <a href="${SITE_URL}/account.html" style="color:#a78bfa;">${SITE_URL}/account.html</a></li>
        <li>Enter your email: <strong>${cleanEmail}</strong></li>
        <li>Enter the temporary password above</li>
        <li>Click <strong>Sign In</strong></li>
      </ol>`;
    signInText = `YOUR TEMPORARY PASSWORD: ${tempPassword}\n\nPlease change this after your first sign-in.\n\n` +
      `How to sign in:\n1. Go to ${SITE_URL}/account.html\n2. Enter your email: ${cleanEmail}\n3. Enter the temporary password above\n4. Click Sign In`;
  } else if (actionLink) {
    // Existing user with magic link
    signInBlock = `
      <div style="text-align:center;margin:28px 0;">
        <a href="${actionLink}" style="background:#7c3aed;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;margin:12px 0;">
          Sign In to Your Account
        </a>
      </div>
      <p style="font-size:0.85em;color:#6b7280;">
        Or sign in manually at <a href="${SITE_URL}/account.html" style="color:#a78bfa;">${SITE_URL}/account.html</a> with your existing password.
      </p>`;
    signInText = `Sign in here: ${actionLink}\n\nOr go to ${SITE_URL}/account.html and use your existing password.`;
  } else {
    // Fallback
    signInBlock = `
      <div style="text-align:center;margin:28px 0;">
        <a href="${SITE_URL}/account.html" style="background:#7c3aed;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;margin:12px 0;">
          Go to Account Page
        </a>
      </div>`;
    signInText = `Go to ${SITE_URL}/account.html to sign in.`;
  }

  const htmlBody = `
<!DOCTYPE html>
<html>
<body style="background:#0a0014;color:#e2e8f0;font-family:sans-serif;padding:32px;max-width:560px;margin:0 auto;">
  <h1 style="color:#a78bfa;margin-bottom:4px;">🎉 You're In!</h1>
  <p style="color:#9ca3af;margin-top:0;">Your ViriTTS Beta access has been approved.</p>
  <hr style="border-color:#2d1b4e;margin:20px 0;" />
  <p>Hey <strong>${cleanName}</strong>,</p>
  <p>We've reviewed your application and you're officially approved for the <strong>ViriTTS Beta</strong>! Here's everything you need to get started:</p>

  <div style="background:#1a112e;border:1px solid #4c1d95;border-radius:10px;padding:20px;margin:20px 0;">
    <p style="margin:0 0 6px;color:#9ca3af;font-size:0.85em;">YOUR LICENSE KEY</p>
    <p style="margin:0;font-size:1.4em;font-weight:bold;letter-spacing:2px;color:#a78bfa;">${license_key}</p>
    <p style="margin:8px 0 0;font-size:0.8em;color:#6b7280;">Expires: ${expiryStr}</p>
  </div>

  ${signInBlock}

  <p style="margin-top:20px;"><strong>After signing in:</strong></p>
  <ol style="color:#d1d5db;line-height:1.8;">
    <li>Your license key will appear in your Account portal</li>
    <li>Click the <strong>Download</strong> button to get ViriTTS</li>
    <li>Open ViriTTS and enter your license key when prompted</li>
  </ol>

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
    signInText,
    "",
    "After signing in:",
    "1. Your license key will appear in your Account portal",
    "2. Click the Download button to get ViriTTS",
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
      already_exists: !!existingUser,
      temp_password: tempPassword,
      action_link: actionLink,
      error: `Email failed to send: ${emailResult.error}`,
      create_error: createError,
    }, 500);
  }

  return jsonResponse({
    success: true,
    already_exists: !!existingUser,
    temp_password_set: !!tempPassword,
    action_link: actionLink,
    create_error: createError,
    license_key,
    expires: expiryStr,
    name: cleanName,
  });
});
