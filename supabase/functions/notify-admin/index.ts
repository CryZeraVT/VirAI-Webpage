// verify_jwt: false — custom auth:
//   - Internal (edge→edge): header x-airi-alert-secret === ALERT_INTERNAL_SECRET
//   - Admin test send: Authorization Bearer JWT + profiles.is_admin
//   - Health: GET or POST { action: "health" } (no email, no secrets leaked)
//
// Sends ops alerts via Resend (RESEND_API_KEY). Recipients from
// system_config.alert_settings (never publicly readable).
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
const alertSecret = Deno.env.get("ALERT_INTERNAL_SECRET") ?? "";

const FROM_ADDRESS = "AiRi Alerts <noreply@virflowsocial.com>";
const SUBJECT_PREFIX = "[AiRi ALERT]";

const DEFAULT_SETTINGS = {
  recipients: [] as string[],
  enabled: true,
  enabled_classes: {
    p0_downtime: true,
    p1_failover: true,
    p1_stripe: true,
    p2_digest: false,
  },
  min_severity: "P1",
  mute_until: null as string | null,
  dedupe_window_sec: 600,
};

const ALLOWED_CLASSES = new Set([
  "p0_downtime",
  "p1_failover",
  "p1_stripe",
  "p2_digest",
  "test",
]);

const SEV_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2 };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-airi-alert-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function serviceClient() {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function requireAdminJwt(req: Request): Promise<{ ok: true; userId: string } | { ok: false; status: number; error: string }> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Missing Authorization" };
  }
  const jwt = auth.slice(7).trim();
  if (!jwt) return { ok: false, status: 401, error: "Missing Authorization" };

  const userClient = createClient(supabaseUrl, anonKey || serviceRoleKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return { ok: false, status: 401, error: "Invalid session" };
  }

  const sb = serviceClient();
  const { data: profile } = await sb
    .from("profiles")
    .select("is_admin")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (!profile?.is_admin) {
    return { ok: false, status: 403, error: "Admin access required" };
  }
  return { ok: true, userId: userData.user.id };
}

function isInternalAuthorized(req: Request): boolean {
  if (!alertSecret) return false;
  const hdr = req.headers.get("x-airi-alert-secret") ?? "";
  return !!hdr && hdr === alertSecret;
}

type AlertSettings = typeof DEFAULT_SETTINGS;

function normalizeSettings(raw: unknown): AlertSettings {
  const v = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  const classes = (v.enabled_classes && typeof v.enabled_classes === "object")
    ? v.enabled_classes as Record<string, unknown>
    : {};
  const recipients = Array.isArray(v.recipients)
    ? v.recipients.map((e) => String(e).trim().toLowerCase()).filter(Boolean)
    : [];
  const minSev = String(v.min_severity ?? "P1").toUpperCase();
  return {
    recipients,
    enabled: v.enabled !== false,
    enabled_classes: {
      p0_downtime: classes.p0_downtime !== false,
      p1_failover: classes.p1_failover !== false,
      p1_stripe: classes.p1_stripe !== false,
      p2_digest: classes.p2_digest === true,
    },
    min_severity: (minSev === "P0" || minSev === "P1" || minSev === "P2") ? minSev : "P1",
    mute_until: v.mute_until == null || v.mute_until === ""
      ? null
      : String(v.mute_until),
    dedupe_window_sec: Math.min(
      86400,
      Math.max(60, Number(v.dedupe_window_sec) || 600),
    ),
  };
}

async function loadSettings(): Promise<AlertSettings> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("system_config")
    .select("value")
    .eq("key", "alert_settings")
    .maybeSingle();
  if (error) {
    console.error("alert_settings read failed:", error.message);
    return { ...DEFAULT_SETTINGS };
  }
  return normalizeSettings(data?.value);
}

async function claimDedupe(
  dedupeKey: string,
  windowSec: number,
): Promise<"send" | "skip"> {
  const sb = serviceClient();
  const now = new Date();
  const { data: existing } = await sb
    .from("alert_dedupe")
    .select("last_sent_at")
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();

  if (existing?.last_sent_at) {
    const last = new Date(existing.last_sent_at).getTime();
    if (Number.isFinite(last) && (now.getTime() - last) < windowSec * 1000) {
      return "skip";
    }
  }

  const { error } = await sb.from("alert_dedupe").upsert({
    dedupe_key: dedupeKey,
    last_sent_at: now.toISOString(),
  }, { onConflict: "dedupe_key" });

  if (error) {
    // Fail open on dedupe write errors (still try to send once).
    console.error("alert_dedupe upsert failed:", error.message);
  }
  return "send";
}

async function sendResend(
  to: string[],
  subject: string,
  html: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!resendApiKey) return { ok: false, error: "RESEND_API_KEY not configured" };
  if (to.length === 0) return { ok: false, error: "No recipients" };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to,
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: err };
  }
  return { ok: true };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  // Health ping — no auth, no email (uptime monitors / probes)
  if (req.method === "GET") {
    return jsonResponse({
      ok: true,
      service: "notify-admin",
      resend_configured: !!resendApiKey,
      secret_configured: !!alertSecret,
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (body.action === "health") {
    return jsonResponse({
      ok: true,
      service: "notify-admin",
      resend_configured: !!resendApiKey,
      secret_configured: !!alertSecret,
    });
  }

  const internal = isInternalAuthorized(req);
  let adminOk = false;
  if (!internal) {
    const admin = await requireAdminJwt(req);
    if (!admin.ok) {
      return jsonResponse({ error: admin.error }, admin.status);
    }
    adminOk = true;
  }

  const alertClass = String(body.class ?? (body.action === "test" ? "test" : "")).trim();
  const severity = String(body.severity ?? (alertClass === "test" ? "P1" : "")).toUpperCase();
  const title = String(body.title ?? "").trim();
  const detail = String(body.detail ?? "").trim();
  const source = String(body.source ?? (adminOk ? "admin-ui" : "internal")).trim();
  const isTest = body.action === "test" || alertClass === "test";

  if (!ALLOWED_CLASSES.has(alertClass) && !isTest) {
    return jsonResponse({ error: "Invalid class" }, 400);
  }
  if (!isTest && !(severity in SEV_RANK)) {
    return jsonResponse({ error: "severity must be P0, P1, or P2" }, 400);
  }
  if (!title) {
    return jsonResponse({ error: "title is required" }, 400);
  }

  const settings = await loadSettings();

  // Test send from admin UI bypasses mute/class/min_severity but still needs recipients + enabled
  if (!isTest) {
    if (!settings.enabled) {
      return jsonResponse({ ok: true, skipped: "disabled" });
    }
    if (settings.mute_until) {
      const muteUntil = new Date(settings.mute_until).getTime();
      if (Number.isFinite(muteUntil) && Date.now() < muteUntil) {
        return jsonResponse({ ok: true, skipped: "muted" });
      }
    }
    const minRank = SEV_RANK[settings.min_severity] ?? 1;
    const sevRank = SEV_RANK[severity] ?? 99;
    if (sevRank > minRank) {
      return jsonResponse({ ok: true, skipped: "below_min_severity" });
    }
    const classKey = alertClass as keyof typeof settings.enabled_classes;
    if (classKey in settings.enabled_classes && !settings.enabled_classes[classKey]) {
      return jsonResponse({ ok: true, skipped: "class_disabled" });
    }
  } else if (!settings.enabled && !adminOk) {
    return jsonResponse({ ok: true, skipped: "disabled" });
  }

  if (settings.recipients.length === 0) {
    return jsonResponse({ ok: false, error: "No alert recipients configured" }, 400);
  }

  const effectiveClass = isTest ? "test" : alertClass;
  const effectiveSeverity = isTest ? "P1" : severity;

  // Dedupe: P0 uses shorter window (60s); P1/P2 use configured window.
  // Test sends always send (dedupe_key optional / unique).
  const windowSec = effectiveSeverity === "P0"
    ? Math.min(60, settings.dedupe_window_sec)
    : settings.dedupe_window_sec;

  const dedupeKey = isTest
    ? `test:${Date.now()}`
    : String(body.dedupe_key ?? `${effectiveClass}:${effectiveSeverity}:${title}`).slice(0, 200);

  if (!isTest) {
    const claim = await claimDedupe(dedupeKey, windowSec);
    if (claim === "skip") {
      return jsonResponse({ ok: true, skipped: "deduped", dedupe_key: dedupeKey });
    }
  }

  const subject = `${SUBJECT_PREFIX} ${effectiveSeverity} ${title}`.slice(0, 200);
  const when = new Date().toISOString();
  const html = `<!DOCTYPE html>
<html><body style="background:#0a0014;color:#e2e8f0;font-family:Segoe UI,Arial,sans-serif;padding:28px;max-width:640px;margin:0 auto;">
  <h1 style="color:#f87171;margin:0 0 8px;font-size:1.25rem;">${escapeHtml(SUBJECT_PREFIX)} ${escapeHtml(effectiveSeverity)}</h1>
  <p style="color:#fbbf24;font-weight:700;margin:0 0 16px;">${escapeHtml(title)}</p>
  <hr style="border-color:#2d1b4e;margin:16px 0;" />
  <pre style="white-space:pre-wrap;color:#d1d5db;font-size:0.9rem;background:#12001f;padding:14px;border-radius:8px;">${escapeHtml(detail || "(no detail)")}</pre>
  <p style="color:#6b7280;font-size:0.8rem;margin-top:18px;">
    class=<strong style="color:#a78bfa;">${escapeHtml(effectiveClass)}</strong>
    · source=<strong style="color:#a78bfa;">${escapeHtml(source)}</strong>
    · ${escapeHtml(when)}
  </p>
  <p style="color:#4b5563;font-size:0.75rem;">AiRi ops alert · viritts.com · manage recipients in admin → Alerts</p>
</body></html>`;

  const text = [
    `${SUBJECT_PREFIX} ${effectiveSeverity}: ${title}`,
    "",
    detail || "(no detail)",
    "",
    `class=${effectiveClass} source=${source} at=${when}`,
  ].join("\n");

  try {
    const result = await sendResend(settings.recipients, subject, html, text);
    if (!result.ok) {
      console.error("notify-admin Resend failed:", result.error);
      return jsonResponse({ ok: false, error: result.error ?? "send failed" }, 502);
    }
    return jsonResponse({
      ok: true,
      sent: settings.recipients.length,
      class: effectiveClass,
      severity: effectiveSeverity,
      dedupe_key: dedupeKey,
    });
  } catch (e) {
    console.error("notify-admin send exception:", e);
    // Never hard-fail callers in a surprising way — still return JSON error.
    return jsonResponse({ ok: false, error: "send exception" }, 502);
  }
});
