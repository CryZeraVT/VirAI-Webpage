import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl    = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const resendApiKey   = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM_ADDRESS   = "AiRi <noreply@virflowsocial.com>";
const SITE_URL       = "https://viritts.com";
const IMG_BASE       = "https://viritts.com/images";

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

function buildHtml(subject: string, bodyHtml: string): string {
  // bodyHtml is pre-formatted HTML from Quill editor (or plain text converted to <p> tags)

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#0d0020;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0d0020;min-height:100vh;">
<tr><td align="center" style="padding:40px 16px;">

  <!-- Outer card -->
  <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

    <!-- ══ HEADER ══ -->
    <tr>
      <td align="center" style="background:linear-gradient(160deg,#1e0533 0%,#3b0764 40%,#0c4a6e 100%);border-radius:16px 16px 0 0;padding:36px 40px 24px;border:1px solid rgba(167,139,250,0.25);border-bottom:none;">

        <!-- Logo image -->
        <table align="center" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
          <img src="${IMG_BASE}/airittstextonly.png" alt="AiRi" width="140" height="auto" style="max-width:140px;margin-bottom:16px;" onerror="this.style.display='none'">
        </td></tr></table>

        <!-- Mascot centered via table -->
        <table align="center" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
          <img src="${IMG_BASE}/virittsplusmascot.png" alt="AiRi" width="120" height="auto" style="max-width:120px;" onerror="this.style.display='none'">
        </td></tr></table>

      </td>
    </tr>

    <!-- ══ SUBJECT BANNER ══ -->
    <tr>
      <td style="background:linear-gradient(90deg,#2e1065,#1e3a5f);padding:28px 40px 20px;border-left:1px solid rgba(167,139,250,0.25);border-right:1px solid rgba(167,139,250,0.25);">
        <p style="margin:0;font-size:1.3rem;font-weight:800;color:#f0e6ff;font-family:'Segoe UI',Arial,sans-serif;line-height:1.3;letter-spacing:-0.2px;">${subject}</p>
        <div style="margin-top:10px;height:2px;background:linear-gradient(90deg,#7c3aed,#06b6d4,transparent);border-radius:999px;"></div>
      </td>
    </tr>

    <!-- ══ BODY ══ -->
    <tr>
      <td style="background:#0f0621;padding:28px 40px 8px;border-left:1px solid rgba(167,139,250,0.25);border-right:1px solid rgba(167,139,250,0.25);">
        <style>
          .ec p{margin:0 0 12px;color:#c4b5fd;font-size:.97rem;line-height:1.8;font-family:'Segoe UI',Arial,sans-serif}
          .ec h1,.ec h2,.ec h3{color:#f0e6ff;margin:0 0 12px;font-weight:700;font-family:'Segoe UI',Arial,sans-serif}
          .ec h1{font-size:1.5rem}.ec h2{font-size:1.2rem}.ec h3{font-size:1rem}
          .ec ul,.ec ol{margin:0 0 14px;padding-left:20px;color:#c4b5fd;font-size:.97rem;line-height:1.8;font-family:'Segoe UI',Arial,sans-serif}
          .ec li{margin-bottom:6px}
          .ec blockquote{margin:0 0 14px;padding:10px 16px;border-left:4px solid #7c3aed;background:rgba(124,58,237,.1);color:#a78bfa}
          .ec a{color:#a78bfa}
          .ec strong{color:#f0e6ff}
          .ec em{color:#d1d5db}
          .ec pre{background:#1e1835;color:#c4b5fd;padding:10px 14px;border-radius:6px;overflow:auto}
          .ec code{background:#1e1835;color:#c4b5fd;padding:2px 5px;border-radius:4px;font-size:.9em}
        </style>
        <div class="ec">${bodyHtml}</div>
      </td>
    </tr>

    <!-- ══ CTA ══ -->
    <tr>
      <td style="background:#0f0621;padding:20px 40px 36px;text-align:center;border-left:1px solid rgba(167,139,250,0.25);border-right:1px solid rgba(167,139,250,0.25);">
        <a href="${SITE_URL}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed 0%,#06b6d4 100%);color:#ffffff;text-decoration:none;font-weight:700;font-size:0.95rem;padding:14px 40px;border-radius:999px;font-family:'Segoe UI',Arial,sans-serif;letter-spacing:0.03em;">Explore AiRi &rarr;</a>
      </td>
    </tr>

    <!-- ══ DIVIDER ══ -->
    <tr>
      <td style="background:#0f0621;padding:0 40px;border-left:1px solid rgba(167,139,250,0.25);border-right:1px solid rgba(167,139,250,0.25);">
        <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(124,58,237,0.4),transparent);"></div>
      </td>
    </tr>

    <!-- ══ FOOTER ══ -->
    <tr>
      <td style="background:#080014;padding:24px 40px;text-align:center;border-radius:0 0 16px 16px;border:1px solid rgba(167,139,250,0.25);border-top:none;">
        <p style="margin:0 0 6px;font-size:0.78rem;color:#6b7280;font-family:'Segoe UI',Arial,sans-serif;">
          You're getting this because you signed up at
          <a href="${SITE_URL}" style="color:#a78bfa;text-decoration:none;">${SITE_URL}</a>
        </p>
        <p style="margin:0;font-size:0.72rem;color:#3d3550;font-family:'Segoe UI',Arial,sans-serif;">
          &copy; ${new Date().getFullYear()} AiRi &mdash; All rights reserved
        </p>
      </td>
    </tr>

  </table>
  <!-- end card -->

</td></tr>
</table>
</body>
</html>`;
}

async function sendResendEmail(to: string, subject: string, html: string, text: string) {
  if (!resendApiKey) return { ok: false, error: "RESEND_API_KEY not configured" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
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
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase   = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: authHeader } } });

  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

  const { data: profile } = await supabase.from("profiles").select("is_admin").eq("id", user.id).single();
  if (!profile?.is_admin) return jsonResponse({ error: "Admin access required" }, 403);

  let subject: string, bodyHtml: string, bodyText: string;
  try {
    const payload = await req.json();
    subject  = String(payload.subject  ?? "").trim();
    bodyText = String(payload.body     ?? "").trim();
    // body_html from rich editor; fall back to wrapping plain text in <p> tags
    const rawHtml = String(payload.body_html ?? "").trim();
    bodyHtml = rawHtml && rawHtml !== "<p><br></p>"
      ? rawHtml
      : bodyText.split("\n").map(l => l.trim() ? `<p>${l}</p>` : "<p><br></p>").join("");
  } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
  if (!subject || (!bodyText && !bodyHtml)) return jsonResponse({ error: "subject and body are required" }, 400);

  const { data: subscribers, error: subError } = await supabase
    .from("mailing_list").select("email, name").eq("subscribed", true);
  if (subError) return jsonResponse({ error: subError.message }, 500);
  if (!subscribers || subscribers.length === 0) return jsonResponse({ sent: 0, total: 0, message: "No active subscribers" });

  const html = buildHtml(subject, bodyHtml);
  let sent = 0;
  const errors: string[] = [];

  for (const sub of subscribers) {
    const result = await sendResendEmail(sub.email, subject, html, bodyText);
    if (result.ok) sent++;
    else errors.push(`${sub.email}: ${result.error}`);
  }

  return jsonResponse({ sent, total: subscribers.length, errors: errors.length ? errors : undefined });
});
