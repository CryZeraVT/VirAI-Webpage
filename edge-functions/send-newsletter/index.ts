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

// Footer variants:
//   - "subscriber" → standard mailing-list footer with tokenised
//     one-click unsubscribe link. Requires a non-empty token.
//   - "beta"       → transactional-style footer for active beta
//     testers who are NOT on the mailing list. No token available,
//     so no one-click unsubscribe. Copy reads as a product-comms
//     message ("you're getting this because you're a beta tester")
//     with a contact-to-opt-out line. Under CAN-SPAM, product
//     communications to active users are transactional and don't
//     require a one-click opt-out, but we still provide the manual
//     path to be good citizens.
type FooterVariant = "subscriber" | "beta";

function buildHtml(subject: string, bodyHtml: string, unsubscribeToken: string | null, variant: FooterVariant = "subscriber"): string {
  const styledBody = inlineStyles(bodyHtml);
  // Token unsubscribe URL only used for "subscriber" variant.
  const unsubscribeUrl = unsubscribeToken
    ? `${supabaseUrl}/functions/v1/unsubscribe?token=${unsubscribeToken}`
    : "";
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f7;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f7;">
<tr><td align="center" style="padding:20px 16px 32px;">
<table width="620" cellpadding="0" cellspacing="0" border="0" style="max-width:620px;width:100%;">

  <!-- ══ HEADER BAR ══ -->
  <tr>
    <td style="padding-bottom:0;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="background:linear-gradient(90deg,#2a0040 0%,#0f0018 30%,#080014 52%,#000d30 72%,#001848 100%);border-radius:14px 14px 0 0;padding:18px 36px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td valign="middle">
              <img src="${IMG_BASE}/airittstextonly.png" alt="AiRi" width="150" height="auto" style="max-width:150px;display:block;" onerror="this.style.display='none'">
            </td>
            <td width="100%"></td>
            <td valign="middle" style="padding:0 20px;">
              <div style="width:1px;height:40px;background:rgba(255,255,255,0.2);"></div>
            </td>
            <td valign="middle">
              <img src="${IMG_BASE}/VirForge-transpar.png" alt="VirForge" width="130" height="auto" style="max-width:130px;display:block;" onerror="this.style.display='none'">
            </td>
          </tr></table>
        </td>
      </tr></table>
    </td>
  </tr>

  <!-- ══ CONTENT CARD ══ -->
  <tr>
    <td>
      <table width="100%" cellpadding="0" cellspacing="0" border="0">

        <!-- Subject -->
        <tr>
          <td style="background:#ffffff;padding:32px 44px 18px;">
            <p style="margin:0;font-size:1.4rem;font-weight:800;color:#111827;font-family:'Segoe UI',Arial,sans-serif;line-height:1.3;letter-spacing:-0.3px;">${subject}</p>
          </td>
        </tr>

        <!-- Purple→cyan separator line -->
        <tr>
          <td style="background:#ffffff;padding:0 44px 20px;">
            <div style="height:3px;background:linear-gradient(90deg,#7c3aed,#06b6d4);border-radius:999px;"></div>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="background:#ffffff;padding:4px 44px 12px;">
            ${styledBody}
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td style="background:#ffffff;padding:20px 44px 44px;text-align:center;border-radius:0 0 14px 14px;">
            <a href="${SITE_URL}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed 0%,#06b6d4 100%);color:#ffffff;text-decoration:none;font-weight:700;font-size:1rem;padding:16px 48px;border-radius:999px;font-family:'Segoe UI',Arial,sans-serif;letter-spacing:0.03em;">Explore AiRi &rarr;</a>
          </td>
        </tr>

      </table>
    </td>
  </tr>

  <!-- ══ FOOTER ══ -->
  <tr>
    <td style="padding:18px 44px;text-align:center;">
      ${variant === "subscriber" ? `
      <p style="margin:0 0 4px;font-size:0.78rem;color:#6b7280;font-family:'Segoe UI',Arial,sans-serif;">
        You're getting this because you signed up at
        <a href="${SITE_URL}" style="color:#7c3aed;text-decoration:none;">${SITE_URL}</a>
      </p>
      <p style="margin:0 0 6px;font-size:0.74rem;color:#9ca3af;font-family:'Segoe UI',Arial,sans-serif;">
        &copy; ${new Date().getFullYear()} AiRi &mdash; A <strong style="color:#7c3aed;">VirForge</strong> Product
      </p>
      <p style="margin:0;font-size:0.72rem;color:#6b7280;font-family:'Segoe UI',Arial,sans-serif;">
        Don't want these emails?
        <a href="${unsubscribeUrl}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe</a>
      </p>
      ` : `
      <p style="margin:0 0 4px;font-size:0.78rem;color:#6b7280;font-family:'Segoe UI',Arial,sans-serif;">
        You're receiving this because you're an active <strong style="color:#7c3aed;">AiRi beta tester</strong>.
      </p>
      <p style="margin:0 0 6px;font-size:0.74rem;color:#9ca3af;font-family:'Segoe UI',Arial,sans-serif;">
        &copy; ${new Date().getFullYear()} AiRi &mdash; A <strong style="color:#7c3aed;">VirForge</strong> Product
      </p>
      <p style="margin:0;font-size:0.72rem;color:#6b7280;font-family:'Segoe UI',Arial,sans-serif;">
        Don't want beta update emails? Reply to this message or contact us directly and we'll remove you.
      </p>
      `}
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

  // ── Parse body ──────────────────────────────────────────────────────
  // Body shape:
  //   { subject, body, body_html, audiences?, dry_run? }
  //
  // ``audiences`` is an optional array: ["subscribers"] | ["beta_testers"]
  //   | ["subscribers", "beta_testers"]. Omitted → defaults to
  //   ["subscribers"] so legacy callers stay working.
  //
  // ``dry_run`` returns recipient counts without sending a single email.
  //   Used by admin.html to live-update the "Total recipients" badge
  //   as checkboxes are toggled. Still admin-gated — we don't leak
  //   subscriber counts to non-admins.
  let subject: string, bodyHtml: string, bodyText: string;
  let audiences: string[] = ["subscribers"];
  let dryRun = false;
  try {
    const payload = await req.json();
    subject  = String(payload.subject  ?? "").trim();
    bodyText = String(payload.body     ?? "").trim();
    // body_html from rich editor; fall back to wrapping plain text in <p> tags
    const rawHtml = String(payload.body_html ?? "").trim();
    bodyHtml = rawHtml && rawHtml !== "<p><br></p>"
      ? rawHtml
      : bodyText.split("\n").map(l => l.trim() ? `<p>${l}</p>` : "<p><br></p>").join("");
    if (Array.isArray(payload.audiences) && payload.audiences.length > 0) {
      audiences = payload.audiences
        .map((a: unknown) => String(a ?? "").trim().toLowerCase())
        .filter((a: string) => a === "subscribers" || a === "beta_testers");
    }
    dryRun = payload.dry_run === true;
  } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }

  if (audiences.length === 0) {
    return jsonResponse({ error: "At least one audience (\"subscribers\" or \"beta_testers\") is required." }, 400);
  }
  if (!dryRun && (!subject || (!bodyText && !bodyHtml))) {
    return jsonResponse({ error: "subject and body are required" }, 400);
  }

  // ── Fetch both audience pools ───────────────────────────────────────
  // For dry_run we always fetch both so the admin UI can render all
  // three pre-computed counts (subs only, beta only, both deduped)
  // from a single call without flipping checkboxes = flipping API trips.
  // For real sends we only fetch what was requested.
  const wantSubscribers = dryRun || audiences.includes("subscribers");
  const wantBeta        = dryRun || audiences.includes("beta_testers");

  type Recipient = { email: string; name: string | null; unsubscribe_token: string | null };
  let subscribers: Recipient[] = [];
  let betaTesters: Recipient[] = [];

  if (wantSubscribers) {
    const { data, error } = await supabase
      .from("mailing_list")
      .select("email, name, unsubscribe_token")
      .eq("subscribed", true);
    if (error) return jsonResponse({ error: error.message }, 500);
    subscribers = (data ?? []).filter(r => r.email).map(r => ({
      email: String(r.email).trim(),
      name:  r.name ?? null,
      unsubscribe_token: r.unsubscribe_token ?? null,
    }));
  }

  if (wantBeta) {
    // Active beta licenses = people currently using AiRi on a beta tier.
    // NOT the beta_signups waitlist — those are reached via the
    // approval-email flow instead. We only read ``email``; no PII beyond
    // what was already available via the unrelated mailing_list query.
    const { data, error } = await supabase
      .from("licenses")
      .select("email")
      .eq("tier", "beta")
      .eq("status", "active")
      .not("email", "is", null);
    if (error) return jsonResponse({ error: error.message }, 500);
    // One person may hold multiple beta licenses over time — dedupe
    // within the pool before even looking at mailing_list overlap.
    const seen = new Set<string>();
    for (const row of data ?? []) {
      const emailRaw = String(row.email ?? "").trim();
      if (!emailRaw) continue;
      const key = emailRaw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      betaTesters.push({ email: emailRaw, name: null, unsubscribe_token: null });
    }
  }

  // ── Dry-run: just report counts ─────────────────────────────────────
  if (dryRun) {
    const subSet  = new Set(subscribers.map(r => r.email.toLowerCase()));
    const betaSet = new Set(betaTesters.map(r => r.email.toLowerCase()));
    let overlap = 0;
    for (const e of betaSet) { if (subSet.has(e)) overlap++; }
    const bothDeduped = subSet.size + betaSet.size - overlap;
    return jsonResponse({
      dry_run: true,
      counts: {
        subscribers:     subSet.size,
        beta_testers:    betaSet.size,
        overlap,
        both_deduped:    bothDeduped,
      },
    });
  }

  // ── Build deduped send list ─────────────────────────────────────────
  // Key = lowercased email. When someone is in BOTH pools we prefer the
  // subscriber row because it has an unsubscribe token → legally
  // stronger footer, and respects their stated "I want marketing" intent
  // over the weaker "they're a beta tester" default.
  type Send = Recipient & { variant: FooterVariant };
  const byEmail = new Map<string, Send>();

  if (audiences.includes("subscribers")) {
    for (const r of subscribers) {
      const key = r.email.toLowerCase();
      if (!byEmail.has(key)) {
        byEmail.set(key, { ...r, variant: "subscriber" });
      }
    }
  }
  if (audiences.includes("beta_testers")) {
    for (const r of betaTesters) {
      const key = r.email.toLowerCase();
      if (!byEmail.has(key)) {
        byEmail.set(key, { ...r, variant: "beta" });
      }
    }
  }

  const recipients = Array.from(byEmail.values());
  if (recipients.length === 0) {
    return jsonResponse({ sent: 0, total: 0, message: "No recipients for the selected audience." });
  }

  let sent = 0;
  const errors: string[] = [];

  for (const r of recipients) {
    const html = buildHtml(subject, bodyHtml, r.unsubscribe_token, r.variant);
    const result = await sendResendEmail(r.email, subject, html, bodyText);
    if (result.ok) sent++;
    else errors.push(`${r.email}: ${result.error}`);
  }

  return jsonResponse({
    sent,
    total: recipients.length,
    audiences,
    breakdown: {
      subscribers:  recipients.filter(r => r.variant === "subscriber").length,
      beta_testers: recipients.filter(r => r.variant === "beta").length,
    },
    errors: errors.length ? errors : undefined,
  });
});
