import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(supabaseUrl, serviceRoleKey);

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

async function requireAdmin(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]?.trim()) {
    return { error: jsonResponse({ error: "Missing Authorization header." }, 401) };
  }
  const { data: userData, error: userError } = await supabase.auth.getUser(match[1].trim());
  if (userError || !userData?.user) {
    return { error: jsonResponse({ error: "Invalid or expired session." }, 401) };
  }
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileError) {
    console.error("debug-user admin check failed:", profileError.message);
    return { error: jsonResponse({ error: "Could not verify admin access." }, 500) };
  }
  if (!profile?.is_admin) {
    return { error: jsonResponse({ error: "Admin access required." }, 403) };
  }
  return { user: userData.user };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  const admin = await requireAdmin(req);
  if ("error" in admin) return admin.error;

  const { email } = await req.json().catch(() => ({}));
  const wanted = String(email ?? "").trim().toLowerCase();
  if (!wanted || wanted.length > 254) {
    return jsonResponse({ error: "A valid search value is required." }, 400);
  }

  // Paginate all users and collect matches + total count
  const pageSize = 200;
  let page = 1;
  let totalSeen = 0;
  const matches: unknown[] = [];

  while (page <= 50) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: pageSize });
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500
      });
    }
    const batch = data?.users ?? [];
    totalSeen += batch.length;

    for (const u of batch) {
      const uEmail = String(u.email ?? "").toLowerCase();
      if (wanted && uEmail.includes(wanted)) {
        matches.push({
          id: u.id,
          email: u.email,
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at,
          email_confirmed_at: u.email_confirmed_at,
          banned_until: u.banned_until ?? null,
          identities: u.identities?.length ?? 0,
        });
      }
    }

    if (batch.length < pageSize) break;
    page += 1;
  }

  // Also check profiles, licenses, beta_signups directly
  const { data: profile } = wanted
    ? await supabase.from("profiles").select("*").ilike("twitch_username", `%${wanted.split("@")[0]}%`).limit(5)
    : { data: [] };

  const { data: licenses } = wanted
    ? await supabase.from("licenses").select("*").ilike("email", `%${wanted}%`).limit(5)
    : { data: [] };

  const { data: signups } = wanted
    ? await supabase.from("beta_signups").select("*").ilike("email", `%${wanted}%`).limit(5)
    : { data: [] };

  return new Response(JSON.stringify({
    searched_for: wanted,
    total_auth_users_scanned: totalSeen,
    auth_matches: matches,
    license_matches: licenses ?? [],
    beta_signup_matches: signups ?? [],
    profile_matches: profile ?? [],
  }, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
