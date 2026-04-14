// send-newsletter — Supabase Edge Function
// Deploy via: Supabase Dashboard → Edge Functions → New Function → paste this
// Required secret: RESEND_API_KEY (same key used by send-beta-approval)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API = "https://api.resend.com/emails";
const FROM_ADDRESS = "AiRi <noreply@viritts.com>"; // Change to your verified sender

interface NewsletterPayload {
  subject: string;
  body: string; // plain text — we'll convert to simple HTML
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, apikey, content-type",
      },
    });
  }

  try {
    // Admin-only: verify the caller is an admin
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user } } = await userClient.auth.getUser();
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .single();

    if (!profile?.is_admin) {
      return Response.json({ error: "Admin access required" }, { status: 403, headers: { "Access-Control-Allow-Origin": "*" } });
    }

    // Parse payload
    const { subject, body }: NewsletterPayload = await req.json();
    if (!subject?.trim() || !body?.trim()) {
      return Response.json({ error: "subject and body are required" }, { status: 400 });
    }

    // Fetch all active subscribers
    const { data: subscribers, error: subError } = await supabase
      .from("mailing_list")
      .select("email, name")
      .eq("subscribed", true);

    if (subError) throw subError;
    if (!subscribers || subscribers.length === 0) {
      return Response.json({ sent: 0, message: "No active subscribers" });
    }

    // Convert plain text body to simple HTML (preserves line breaks)
    const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:32px 20px;color:#1a1a2e;background:#fff;">
  <div style="margin-bottom:28px;">
    <img src="https://viritts.com/assets/logo.png" alt="AiRi" style="height:36px;" onerror="this.style.display='none'">
  </div>
  <h2 style="margin:0 0 20px;font-size:1.4rem;color:#1a1a2e;">${subject}</h2>
  <div style="font-size:1rem;line-height:1.7;color:#374151;">
    ${body.replace(/\n/g, "<br>")}
  </div>
  <hr style="margin:32px 0;border:none;border-top:1px solid #e5e7eb;">
  <p style="font-size:0.8rem;color:#9ca3af;margin:0;">
    You're receiving this because you signed up at viritts.com.<br>
    <a href="https://viritts.com" style="color:#7c3aed;">viritts.com</a>
  </p>
</body>
</html>`;

    // Send to each subscriber (Resend free tier: batch or loop)
    let sent = 0;
    const errors: string[] = [];

    for (const sub of subscribers) {
      try {
        const res = await fetch(RESEND_API, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: FROM_ADDRESS,
            to: sub.email,
            subject,
            html: htmlBody,
            text: body,
          }),
        });

        if (res.ok) {
          sent++;
        } else {
          const err = await res.json().catch(() => ({}));
          errors.push(`${sub.email}: ${err?.message || res.status}`);
        }
      } catch (e) {
        errors.push(`${sub.email}: ${e}`);
      }
    }

    return Response.json(
      { sent, total: subscribers.length, errors: errors.length ? errors : undefined },
      { headers: { "Access-Control-Allow-Origin": "*" } }
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }
});
