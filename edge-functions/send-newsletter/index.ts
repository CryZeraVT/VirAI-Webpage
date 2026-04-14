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

// Inject inline styles onto Quill HTML elements — Gmail strips <style> blocks
function inlineStyles(html: string): string {
  function inject(tag: string, style: string, input: string): string {
    const re = new RegExp(`<${tag}(>|\\s)`, "gi");
    return input.replace(re, (_m, end) =>
      `<${tag} style="${style}"${end === ">" ? ">" : " "}`
    );
  }
  let o = html;
  o = inject("p",          "margin:0 0 12px;color:#374151;font-size:.97rem;line-height:1.8;font-family:'Segoe UI',Arial,sans-serif;", o);
  o = inject("h2",         "margin:0 0 14px;color:#111827;font-size:1.2rem;font-weight:700;font-family:'Segoe UI',Arial,sans-serif;", o);
  o = inject("h3",         "margin:0 0 12px;color:#111827;font-size:1rem;font-weight:700;font-family:'Segoe UI',Arial,sans-serif;", o);
  o = inject("ul",         "margin:0 0 14px;padding-left:20px;color:#374151;line-height:1.8;font-family:'Segoe UI',Arial,sans-serif;", o);
  o = inject("ol",         "margin:0 0 14px;padding-left:20px;color:#374151;line-height:1.8;font-family:'Segoe UI',Arial,sans-serif;", o);
  o = inject("li",         "margin-bottom:6px;color:#374151;font-family:'Segoe UI',Arial,sans-serif;", o);
  o = inject("blockquote", "margin:0 0 14px;padding:10px 16px;border-left:4px solid #7c3aed;background:rgba(124,58,237,.06);color:#4b5563;", o);
  o = inject("strong",     "color:#111827;", o);
  o = inject("em",         "color:#4b5563;font-style:italic;", o);
  o = inject("a",          "color:#7c3aed;text-decoration:underline;", o);
  o = inject("img",        "max-width:100%;height:auto;border-radius:8px;display:block;margin:8px 0;", o);
  o = inject("pre",        "background:#f3f4f6;color:#1f2937;padding:10px 14px;border-radius:6px;overflow:auto;margin:0 0 14px;", o);
  o = inject("code",       "background:#f3f4f6;color:#1f2937;padding:2px 5px;border-radius:4px;font-size:.9em;", o);
  return o;
}

function buildHtml(subject: string, bodyHtml: string): string {
  const styledBody = inlineStyles(bodyHtml);
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f7;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f7;min-height:100vh;">
<tr><td align="center" style="padding:36px 16px;">
<table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

  <!-- ══ HEADER BAR — dark gradient, slim, AiRi | divider | VirForge ══ -->
  <tr>
    <td style="padding-bottom:0;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="background:linear-gradient(90deg,#2a0040 0%,#0f0018 30%,#080014 52%,#000d30 72%,#001848 100%);border-radius:14px 14px 0 0;padding:14px 28px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td valign="middle">
              <img src="${IMG_BASE}/airittstextonly.png" alt="AiRi" width="120" height="auto" style="max-width:120px;display:block;" onerror="this.style.display='none'">
            </td>
            <td width="100%"></td>
            <td valign="middle" style="padding:0 16px;">
              <div style="width:1px;height:34px;background:rgba(255,255,255,0.2);"></div>
            </td>
            <td valign="middle">
              <img src="${IMG_BASE}/VirForge-transpar.png" alt="VirForge" width="110" height="auto" style="max-width:110px;display:block;" onerror="this.style.display='none'">
            </td>
          </tr></table>
        </td>
      </tr></table>
    </td>
  </tr>

  <!-- ══ CONTENT CARD — white, subject + gradient line + body + cta ══ -->
  <tr>
    <td>
      <table width="100%" cellpadding="0" cellspacing="0" border="0">

        <!-- Subject -->
        <tr>
          <td style="background:#ffffff;padding:28px 36px 16px;">
            <p style="margin:0;font-size:1.25rem;font-weight:800;color:#111827;font-family:'Segoe UI',Arial,sans-serif;line-height:1.3;letter-spacing:-0.2px;">${subject}</p>
          </td>
        </tr>

        <!-- Purple→cyan separator line -->
        <tr>
          <td style="background:#ffffff;padding:0 36px 16px;">
            <div style="height:3px;background:linear-gradient(90deg,#7c3aed,#06b6d4);border-radius:999px;"></div>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="background:#ffffff;padding:4px 36px 8px;">
            ${styledBody}
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td style="background:#ffffff;padding:16px 36px 36px;text-align:center;border-radius:0 0 14px 14px;">
            <a href="${SITE_URL}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed 0%,#06b6d4 100%);color:#ffffff;text-decoration:none;font-weight:700;font-size:0.95rem;padding:14px 40px;border-radius:999px;font-family:'Segoe UI',Arial,sans-serif;letter-spacing:0.03em;">Explore AiRi &rarr;</a>
          </td>
        </tr>

      </table>
    </td>
  </tr>

  <!-- ══ FOOTER ══ -->
  <tr>
    <td style="padding:18px 36px;text-align:center;">
      <p style="margin:0 0 4px;font-size:0.76rem;color:#6b7280;font-family:'Segoe UI',Arial,sans-serif;">
        You're getting this because you signed up at
        <a href="${SITE_URL}" style="color:#7c3aed;text-decoration:none;">${SITE_URL}</a>
      </p>
      <p style="margin:0 0 4px;font-size:0.72rem;color:#9ca3af;font-family:'Segoe UI',Arial,sans-serif;">
        &copy; ${new Date().getFullYear()} AiRi &mdash; All rights reserved
      </p>
      <p style="margin:0;font-size:0.70rem;color:#b0b8c5;font-family:'Segoe UI',Arial,sans-serif;letter-spacing:0.03em;">
        by <strong style="color:#7c3aed;">VirForge Software</strong>
      </p>
    </td>
  </tr>

</table>
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
