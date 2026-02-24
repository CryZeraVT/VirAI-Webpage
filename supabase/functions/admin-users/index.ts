import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(supabaseUrl, serviceRoleKey);

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

function normalizeEmail(email: unknown): string {
  return String(email ?? "").trim().toLowerCase();
}

async function requireAdmin(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return { error: jsonResponse({ error: "Missing Authorization header." }, 401) };
  }

  const token = authHeader.replace("Bearer ", "");
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) {
    return {
      error: jsonResponse(
        { error: "Unauthorized.", details: userError?.message ?? "Invalid or expired token." },
        401,
      ),
    };
  }

  const requester = userData.user;
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", requester.id)
    .maybeSingle();

  if (profileError) {
    console.error("Admin profile check failed:", profileError);
    return { error: jsonResponse({ error: "Failed to verify admin permissions." }, 500) };
  }

  if (!profile?.is_admin) {
    return { error: jsonResponse({ error: "Forbidden: admin only." }, 403) };
  }

  return { requester };
}

async function findUserByEmail(email: string) {
  const wanted = normalizeEmail(email);
  if (!wanted) return null;

  const pageSize = 200;
  let page = 1;
  while (page <= 20) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: pageSize });
    if (error) throw error;
    const users = data?.users ?? [];
    if (!users.length) break;

    const found = users.find((u) => normalizeEmail(u.email) === wanted);
    if (found) return found;
    if (users.length < pageSize) break;
    page += 1;
  }
  return null;
}

async function listUsers(limitInput: unknown) {
  const limit = Math.max(1, Math.min(500, Number(limitInput) || 200));
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: limit });
  if (error) throw error;

  const users = data?.users ?? [];
  const ids = users.map((u) => u.id).filter(Boolean);
  const emails = Array.from(new Set(users.map((u) => normalizeEmail(u.email)).filter(Boolean)));

  const { data: profiles } = ids.length
    ? await supabase.from("profiles").select("id,is_admin,twitch_username").in("id", ids)
    : { data: [] as Array<{ id: string; is_admin: boolean; twitch_username?: string | null }> };

  const { data: licenses } = emails.length
    ? await supabase.from("licenses").select("email,status").in("email", emails)
    : { data: [] as Array<{ email: string; status: string }> };

  const { data: signups } = emails.length
    ? await supabase.from("beta_signups").select("email,status").in("email", emails)
    : { data: [] as Array<{ email: string; status: string }> };

  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));
  const licenseStats = new Map<string, { total: number; active: number }>();
  for (const lic of licenses ?? []) {
    const email = normalizeEmail(lic.email);
    const current = licenseStats.get(email) ?? { total: 0, active: 0 };
    current.total += 1;
    if (String(lic.status ?? "").toLowerCase() === "active") current.active += 1;
    licenseStats.set(email, current);
  }

  const betaStatusByEmail = new Map<string, string>();
  for (const s of signups ?? []) {
    const email = normalizeEmail(s.email);
    if (!betaStatusByEmail.has(email)) {
      betaStatusByEmail.set(email, String(s.status ?? "unknown"));
    }
  }

  const out = users.map((u) => {
    const email = normalizeEmail(u.email);
    const profile = profileById.get(u.id);
    const lic = licenseStats.get(email) ?? { total: 0, active: 0 };
    return {
      id: u.id,
      email: u.email ?? "",
      created_at: u.created_at ?? null,
      last_sign_in_at: u.last_sign_in_at ?? null,
      is_admin: !!profile?.is_admin,
      twitch_username: profile?.twitch_username ?? "",
      license_count: lic.total,
      active_license_count: lic.active,
      beta_status: betaStatusByEmail.get(email) ?? null,
    };
  });

  return { users: out };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  const adminCheck = await requireAdmin(req);
  if ("error" in adminCheck) return adminCheck.error;
  const requester = adminCheck.requester;

  const payload = await req.json().catch(() => null);
  const action = String(payload?.action ?? "").trim().toLowerCase();

  if (!action) {
    return jsonResponse({ error: "Missing action." }, 400);
  }

  try {
    if (action === "list") {
      const data = await listUsers(payload?.limit);
      return jsonResponse({ success: true, ...data });
    }

    if (action !== "delete") {
      return jsonResponse({ error: `Unsupported action: ${action}` }, 400);
    }

    let userId = String(payload?.user_id ?? "").trim();
    const inputEmail = normalizeEmail(payload?.email);

    let targetUser: { id: string; email?: string | null } | null = null;
    if (userId) {
      const { data, error } = await supabase.auth.admin.getUserById(userId);
      if (error || !data?.user) {
        return jsonResponse({ error: "Target user not found." }, 404);
      }
      targetUser = data.user;
    } else if (inputEmail) {
      const found = await findUserByEmail(inputEmail);
      if (!found) return jsonResponse({ error: "Target user not found." }, 404);
      targetUser = found;
      userId = found.id;
    } else {
      return jsonResponse({ error: "Provide user_id or email." }, 400);
    }

    if (targetUser.id === requester.id) {
      return jsonResponse({ error: "You cannot delete your own admin account from here." }, 400);
    }

    const email = normalizeEmail(targetUser.email || inputEmail);
    const { data: profile } = await supabase
      .from("profiles")
      .select("twitch_username")
      .eq("id", userId)
      .maybeSingle();

    const twitchUsername = String(profile?.twitch_username ?? "").trim();

    const { data: userLicenses, error: licenseListError } = await supabase
      .from("licenses")
      .select("license_key")
      .eq("email", email);
    if (licenseListError) throw licenseListError;
    const licenseKeys = (userLicenses ?? [])
      .map((r) => String(r.license_key ?? "").trim())
      .filter(Boolean);

    if (licenseKeys.length) {
      const { error: tokenDeleteError } = await supabase
        .from("token_usage")
        .delete()
        .in("license_key", licenseKeys);
      if (tokenDeleteError) throw tokenDeleteError;
    }

    if (twitchUsername) {
      await supabase.from("token_usage").delete().eq("twitch_channel", twitchUsername);
      await supabase.from("token_usage").delete().eq("twitch_username", twitchUsername);
    }

    const { error: betaError } = await supabase.from("beta_signups").delete().eq("email", email);
    if (betaError) throw betaError;

    const { error: licenseError } = await supabase.from("licenses").delete().eq("email", email);
    if (licenseError) throw licenseError;

    const { error: profileError } = await supabase.from("profiles").delete().eq("id", userId);
    if (profileError) throw profileError;

    const { error: authDeleteError } = await supabase.auth.admin.deleteUser(userId);
    if (authDeleteError) throw authDeleteError;

    return jsonResponse({
      success: true,
      deleted_auth: true,
      deleted_user_id: userId,
      deleted_email: email,
      deleted_license_count: licenseKeys.length,
    });
  } catch (error) {
    console.error("admin-users error:", error);
    return jsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unexpected server error.",
      },
      500,
    );
  }
});
