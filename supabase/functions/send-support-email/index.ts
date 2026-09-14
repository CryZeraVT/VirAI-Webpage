import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM_ADDRESS = Deno.env.get("FROM_ADDRESS") ?? "ViriTTS <noreply@virflowsocial.com>";
const SUPPORT_EMAIL = Deno.env.get("SUPPORT_EMAIL") ?? "noreply@virflowsocial.com";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://viritts.com",
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

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function consumeLimit(endpoint: string, key: string, limit: number): Promise<boolean | null> {
  const { data, error } = await supabase.rpc("consume_edge_rate_limit", {
    p_endpoint: endpoint,
    p_key_hash: await sha256(key),
    p_limit: limit,
    p_window_seconds: 3600,
  });
  if (error) {
    console.error("support rate-limit check failed:", error.message);
    return null;
  }
  return data === true;
}

async function sendViaResend(payload: {
  from: string;
  to: string[];
  reply_to?: string;
  subject: string;
  html: string;
  text: string;
}) {
  if (!resendApiKey) {
    console.warn("RESEND_API_KEY not set");
    return { ok: false, error: "not configured" };
  }
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
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "Content-Type must be application/json." }, 415);
  }

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const { name, email, subject, message } = body;
  if (!name?.trim() || !email?.trim() || !subject?.trim() || !message?.trim()) {
    return jsonResponse({ error: "Name, email, subject, and message are required." }, 400);
  }

  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  const cleanSubject = subject.trim();
  const cleanMessage = message.trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleanEmail)) {
    return jsonResponse({ error: "Invalid email address." }, 400);
  }
  if (
    cleanName.length > 120 ||
    cleanEmail.length > 254 ||
    cleanSubject.length > 200 ||
    cleanMessage.length > 5000
  ) {
    return jsonResponse({ error: "One or more fields exceed the allowed length." }, 400);
  }

  const forwarded = req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  const [ipAllowed, emailAllowed] = await Promise.all([
    consumeLimit("support:ip", forwarded, 8),
    consumeLimit("support:email", cleanEmail, 3),
  ]);
  if (ipAllowed === null || emailAllowed === null) {
    return jsonResponse({ error: "Support service is temporarily unavailable." }, 503);
  }
  if (!ipAllowed || !emailAllowed) {
    return jsonResponse({ error: "Too many support requests. Please try again later." }, 429);
  }

  const inboundHtml = `<!DOCTYPE html><html><body style="background:#0a0014;color:#e2e8f0;font-family:sans-serif;padding:32px;max-width:600px;margin:0 auto;"><h2 style="color:#a78bfa;">New Support Request — ViriTTS</h2><hr style="border-color:#2d1b4e;"/><p><strong>From:</strong> ${escapeHtml(cleanName)} &lt;${escapeHtml(cleanEmail)}&gt;</p><p><strong>Subject:</strong> ${escapeHtml(cleanSubject)}</p><hr style="border-color:#2d1b4e;"/><div style="background:#1a112e;border:1px solid #4c1d95;border-radius:10px;padding:20px;white-space:pre-wrap;">${escapeHtml(cleanMessage)}</div></body></html>`;
  const inboundText = `New Support Request\nFrom: ${cleanName} <${cleanEmail}>\nSubject: ${cleanSubject}\n\n${cleanMessage}`;

  // Do not send an automatic message to a caller-supplied address. That made
  // this public form an email relay. The support team can still reply normally.
  const inboundResult = await sendViaResend({
    from: FROM_ADDRESS,
    to: [SUPPORT_EMAIL],
    reply_to: cleanEmail,
    subject: `[ViriTTS Support] ${cleanSubject}`,
    html: inboundHtml,
    text: inboundText,
  });

  if (!inboundResult.ok) {
    return jsonResponse({ success: false, error: "Failed to send support request." }, 500);
  }
  return jsonResponse({ success: true });
});
