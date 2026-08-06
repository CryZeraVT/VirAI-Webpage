import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(supabaseUrl, serviceRoleKey);

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Beta renewal config cache ─────────────────────────────────────────────────
// Reads system_config.beta_renewal_config (grace_days, renewal_days).
// Cached for 60s — same TTL pattern as TOS version below.
// Activity keep-alive (2026-08): renew when remaining life < renewal_days/2
// (or already expired). grace_days is retained in config for admin/docs only
// and is NOT used as a renew gate anymore.
interface BetaRenewalConfig { grace_days: number; renewal_days: number; }
const BETA_RENEWAL_DEFAULT: BetaRenewalConfig = { grace_days: 3, renewal_days: 30 };
let _cachedBetaRenewal: BetaRenewalConfig | null = null;
let _cachedBetaRenewalAt = 0;
const BETA_RENEWAL_CACHE_TTL_MS = 60_000;

async function getBetaRenewalConfig(): Promise<BetaRenewalConfig> {
  const now = Date.now();
  if (_cachedBetaRenewal && now - _cachedBetaRenewalAt < BETA_RENEWAL_CACHE_TTL_MS) {
    return _cachedBetaRenewal;
  }
  try {
    const { data, error } = await supabase
      .from("system_config")
      .select("value")
      .eq("key", "beta_renewal_config")
      .maybeSingle();
    if (error || !data?.value) return BETA_RENEWAL_DEFAULT;
    const cfg = data.value as { grace_days?: unknown; renewal_days?: unknown };
    const result: BetaRenewalConfig = {
      grace_days:   Number(cfg.grace_days   ?? BETA_RENEWAL_DEFAULT.grace_days),
      renewal_days: Number(cfg.renewal_days ?? BETA_RENEWAL_DEFAULT.renewal_days),
    };
    if (!Number.isFinite(result.grace_days)   || result.grace_days   < 1) result.grace_days   = BETA_RENEWAL_DEFAULT.grace_days;
    if (!Number.isFinite(result.renewal_days) || result.renewal_days < 1) result.renewal_days = BETA_RENEWAL_DEFAULT.renewal_days;
    _cachedBetaRenewal   = result;
    _cachedBetaRenewalAt = now;
    return result;
  } catch {
    return BETA_RENEWAL_DEFAULT;
  }
}

// Read the current in-app ToS version from site_settings.
// Cached for the lifetime of the isolate (edge fn cold-starts) for minor perf.
let _cachedTosVersion: string | null = null;
let _cachedTosVersionAt = 0;
const TOS_CACHE_TTL_MS = 60_000; // 60s — admin bump takes ≤1 min to propagate

async function getCurrentTosVersion(): Promise<string> {
  const now = Date.now();
  if (_cachedTosVersion && now - _cachedTosVersionAt < TOS_CACHE_TTL_MS) {
    return _cachedTosVersion;
  }
  const { data, error } = await supabase
    .from("site_settings")
    .select("value")
    .eq("key", "app_tos_current_version")
    .maybeSingle();
  if (error || !data?.value) {
    // Fallback: return empty string so the app treats ToS as not-required.
    // This prevents a misconfigured/empty site_settings from blocking all app launches.
    return "";
  }
  _cachedTosVersion = data.value;
  _cachedTosVersionAt = now;
  return data.value;
}

// Fetch the canonical Markdown body + sha256 for a given (surface, version).
// Cached per version for the lifetime of the isolate because rows in
// tos_versions are append-only — if the key exists, the body is immutable,
// so we can cache forever without worrying about staleness.
const _cachedTosBodies: Record<string, { body: string; sha: string }> = {};

async function getTosBody(
  surface: "app" | "web",
  version: string,
): Promise<{ body: string; sha: string }> {
  if (!version) return { body: "", sha: "" };
  const cacheKey = `${surface}:${version}`;
  const hit = _cachedTosBodies[cacheKey];
  if (hit) return hit;

  const { data, error } = await supabase
    .from("tos_versions")
    .select("body_markdown, body_sha256")
    .eq("surface", surface)
    .eq("version", version)
    .maybeSingle();

  if (error || !data) {
    // If the body row is missing for the advertised version, we treat it as
    // "no body available" — the app will fall back to its embedded placeholder.
    // This guarantees that a misconfigured DB NEVER blocks a valid license.
    return { body: "", sha: "" };
  }
  const result = { body: data.body_markdown ?? "", sha: data.body_sha256 ?? "" };
  _cachedTosBodies[cacheKey] = result;
  return result;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ valid: false, message: "Method not allowed." }, 405);
  }

  const payload = await req.json().catch(() => null);
  if (!payload || !payload.license_key) {
    return jsonResponse({ valid: false, message: "Missing license_key." }, 400);
  }

  const licenseKey = String(payload.license_key).trim();
  const machineId = payload.machine_id ? String(payload.machine_id).trim() : "";

  const { data, error } = await supabase
    .from("licenses")
    .select("license_key,status,expires_at,current_period_end,cancel_at_period_end,canceled_at,machine_id,tier,tos_version,tos_accepted_at")
    .eq("license_key", licenseKey)
    .single();

  if (error || !data) {
    return jsonResponse({ valid: false, message: "License key not found." }, 200);
  }

  if (data.status !== "active") {
    return jsonResponse({ valid: false, message: "License is inactive." }, 200);
  }

  // Non-beta: hard-reject past expires_at. Beta skips this gate so activity
  // keep-alive below can self-heal an already-expired but still-active key.
  if (data.tier !== "beta" && data.expires_at) {
    const expiresAt = new Date(data.expires_at);
    if (expiresAt.getTime() < Date.now()) {
      return jsonResponse({ valid: false, message: "License expired." }, 200);
    }
  }

  if (data.machine_id && machineId && data.machine_id !== machineId) {
    return jsonResponse(
      { valid: false, message: "License is already in use on another machine." },
      200,
    );
  }

  // Bind machine_id if first activation, and update last_seen
  const updates: Record<string, string | null> = {
    last_seen: new Date().toISOString(),
  };
  if (!data.machine_id && machineId) {
    updates.machine_id = machineId;
  }

  // ── Beta activity keep-alive ───────────────────────────────────────────────
  // On successful validate for tier=beta with a finite expiry: if already past
  // expires_at OR remaining life < renewal_days/2, set expires_at = now +
  // renewal_days. Coalesce avoids a write on every open once freshly renewed.
  // Non-fatal: a config read failure must never block a valid license check.
  let betaRenewed = false;
  if (data.tier === "beta" && data.expires_at) {
    try {
      const renewalCfg  = await getBetaRenewalConfig();
      const expiresAtMs = new Date(data.expires_at).getTime();
      const renewalMs   = renewalCfg.renewal_days * 24 * 60 * 60 * 1000;
      const remainingMs = expiresAtMs - Date.now();
      if (remainingMs < renewalMs / 2) {
        const newExpiry = new Date(Date.now() + renewalMs);
        updates.expires_at = newExpiry.toISOString();
        betaRenewed = true;
      }
    } catch {
      // Non-fatal — do not block validation
    }
  }

  await supabase.from("licenses").update(updates).eq("license_key", licenseKey);

  // Best-effort: ToS failure must NOT break license validation for existing app builds.
  // If the settings lookup fails, we return tos_current_version="" which the app
  // interprets as "no ToS enforcement right now".
  let tosCurrentVersion = "";
  let tosBody = "";
  let tosBodySha = "";
  try {
    tosCurrentVersion = await getCurrentTosVersion();
    if (tosCurrentVersion) {
      const b = await getTosBody("app", tosCurrentVersion);
      tosBody = b.body;
      tosBodySha = b.sha;
    }
  } catch (_) {
    tosCurrentVersion = "";
    tosBody = "";
    tosBodySha = "";
  }

  // Prefer the subscription period end (written by stripe-webhook on every
  // customer.subscription.updated) over the legacy hard-expiry column.
  // Old app builds only read `expires_at`, so we collapse the two into that
  // field — this heals already-deployed binaries without requiring a client
  // update. Newer app builds read the canonical `current_period_end` /
  // `cancel_at_period_end` fields directly.
  const effectiveExpiresAt = data.current_period_end ?? data.expires_at ?? null;

  return jsonResponse({
    valid: true,
    message: "License activated.",
    expires_at: betaRenewed ? updates.expires_at! : effectiveExpiresAt,
    // ── Subscription fields (new — older app builds will ignore these) ──
    current_period_end:   data.current_period_end ?? null,
    cancel_at_period_end: !!data.cancel_at_period_end,
    canceled_at:          data.canceled_at ?? null,
    // ── Beta auto-renewal (older app builds will ignore this) ──
    beta_renewed:         betaRenewed,
    // ── Terms of Service fields (new — older app builds will ignore these) ──
    tos_current_version:  tosCurrentVersion,
    tos_accepted_version: data.tos_version ?? null,
    tos_accepted_at:      data.tos_accepted_at ?? null,
    // Canonical Markdown body for the current version. Clients render this
    // via their own Markdown engine. Empty string ⇒ client should fall back
    // to its embedded placeholder so the gate never shows blank.
    tos_body_markdown:    tosBody,
    tos_body_sha256:      tosBodySha,
  });
});
