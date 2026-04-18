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
    .select("license_key,status,expires_at,machine_id,tos_version,tos_accepted_at")
    .eq("license_key", licenseKey)
    .single();

  if (error || !data) {
    return jsonResponse({ valid: false, message: "License key not found." }, 200);
  }

  if (data.status !== "active") {
    return jsonResponse({ valid: false, message: "License is inactive." }, 200);
  }

  if (data.expires_at) {
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

  return jsonResponse({
    valid: true,
    message: "License activated.",
    expires_at: data.expires_at ?? null,
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
