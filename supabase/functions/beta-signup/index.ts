import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";

const supabase = createClient(supabaseUrl, serviceRoleKey);

const NOTIFY_RECIPIENTS = ["cryzera@virflowsocial.com"];
const FROM_ADDRESS = "ViriTTS <noreply@virflowsocial.com>";
const ACCOUNT_REDIRECT_URL = "https://www.viritts.com/account.html";

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

async function sendResendEmail(to: string | string[], subject: string, textOrHtml: string, html?: string) {
  if (!resendApiKey) {
    console.warn("RESEND_API_KEY not set — skipping email");
    return;
  }

  const toArray = Array.isArray(to) ? to : [to];
  const payload: Record<string, unknown> = {
    from: FROM_ADDRESS,
    to: toArray,
    subject,
    text: html ? textOrHtml : textOrHtml,
  };
  if (html) payload.html = html;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Resend API error:", err);
  }
}

async function ensureAuthAccountAndInvite(email: string, name: string) {
  const normalizedEmail = email.trim().toLowerCase();

  // Try to create the account via invite
  const { data, error } = await supabase.auth.admin.inviteUserByEmail(normalizedEmail, {
    redirectTo: ACCOUNT_REDIRECT_URL,
  });

  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("already") || msg.includes("exists") || msg.includes("registered")) {
      // Account already exists — generate a magic link instead
      const { data: linkData } = await supabase.auth.admin.generateLink({
        type: "magiclink",
        email: normalizedEmail,
        options: { redirectTo: ACCOUNT_REDIRECT_URL },
      });
      const actionLink = linkData?.properties?.action_link ?? ACCOUNT_REDIRECT_URL;
      return { invited: false, alreadyExists: true, actionLink };
    }
    throw error;
  }

  // Get the invite action link from the response
  const actionLink = data?.user?.action_link ?? ACCOUNT_REDIRECT_URL;
  return { invited: true, alreadyExists: false, userId: data?.user?.id ?? null, actionLink };
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

  // Check for duplicate email
  const { data: existing } = await supabase
    .from("beta_signups")
    .select("id")
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();

  if (existing) {
    return jsonResponse({ error: "This email is already on the beta list!" }, 409);
  }

  // Insert signup
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

  // Create account and get the setup/magic link to embed in our own Resend email.
  let accountCreated = false;
  let accountAlreadyExists = false;
  let actionLink: string = ACCOUNT_REDIRECT_URL;
  try {
    const accountResult = await ensureAuthAccountAndInvite(email.trim(), name.trim());
    accountCreated = !!accountResult.invited;
    accountAlreadyExists = !!accountResult.alreadyExists;
    actionLink = accountResult.actionLink ?? ACCOUNT_REDIRECT_URL;
  } catch (inviteErr) {
    console.error("Auth invite error:", inviteErr);
  }

  // Send notification to team (fire-and-forget)
  sendResendEmail(
    NOTIFY_RECIPIENTS,
    `ViriTTS Beta Signup: ${name.trim()}`,
    [
      "New ViriTTS Beta Application",
      "─".repeat(40),
      `Name:     ${name.trim()}`,
      `Email:    ${email.trim()}`,
      `Twitch:   ${twitch_username.trim()}`,
      `Content:  ${content_type || "Not specified"}`,
      `Message:  ${message?.trim() || "None"}`,
      "",
      "─".repeat(40),
      "Review in Supabase → beta_signups table",
    ].join("\n")
  ).catch((e) => console.error("Team notification failed:", e));

  // Build branded acknowledgment email with the actual account setup link via Resend
  const buttonLabel = accountAlreadyExists ? "Sign In to Your Account" : "Create Your Account";
  const introLine = accountAlreadyExists
    ? "We found an existing account for your email. Use the button below to sign in."
    : "We've created your account. Click the button below to set your password and get ready.";

  const htmlBody = `
<!DOCTYPE html>
<html>
<body style="background:#0a0014;color:#e2e8f0;font-family:sans-serif;padding:32px;max-width:560px;margin:0 auto;">
  <h1 style="color:#a78bfa;margin-bottom:4px;">✅ Application Received!</h1>
  <p style="color:#9ca3af;margin-top:0;">ViriTTS Beta</p>
  <hr style="border-color:#2d1b4e;margin:20px 0;" />
  <p>Hey <strong>${name.trim()}</strong>,</p>
  <p>Thanks for applying to the ViriTTS beta! We're reviewing applications and will reach out when your spot is ready.</p>
  <p>${introLine}</p>
  <div style="text-align:center;margin:28px 0;">
    <a href="${actionLink}" style="background:#7c3aed;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">
      ${buttonLabel}
    </a>
  </div>
  <p style="font-size:0.85em;color:#6b7280;">
    If the button doesn't work, copy this link:<br>
    <span style="word-break:break-all;">${actionLink}</span>
  </p>
  <hr style="border-color:#2d1b4e;margin:20px 0;" />
  <p style="font-size:0.8em;color:#4b5563;">
    — The ViriTTS Team<br>
    <a href="https://viritts.com" style="color:#7c3aed;">viritts.com</a>
  </p>
</body>
</html>`;

  const textBody = [
    `Hey ${name.trim()},`,
    "",
    "Thanks for applying to the ViriTTS beta! We're reviewing applications and will reach out when your spot is ready.",
    "",
    introLine,
    "",
    `${buttonLabel}: ${actionLink}`,
    "",
    "— The ViriTTS Team",
    "https://viritts.com",
  ].join("\n");

  sendResendEmail(
    email.trim(),
    "We Got Your ViriTTS Beta Application!",
    htmlBody,
    textBody,
  ).catch((e) => console.error("Acknowledgment email failed:", e));

  return jsonResponse({
    success: true,
    account_created: accountCreated,
    account_exists: accountAlreadyExists,
  });
});
