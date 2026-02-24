import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl     = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase        = createClient(supabaseUrl, serviceRoleKey);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // 1. Grab all beta signups that have been approved
    const { data: signups, error: signupErr } = await supabase
      .from("beta_signups")
      .select("email, twitch_username, name")
      .eq("status", "approved");

    if (signupErr) throw signupErr;

    // 2. Grab all profiles that have a twitch_username (these are fully linked accounts)
    const { data: profiles, error: profileErr } = await supabase
      .from("profiles")
      .select("twitch_username")
      .not("twitch_username", "is", null)
      .neq("twitch_username", "");

    if (profileErr) console.warn("profiles fetch failed:", profileErr.message);

    // Build de-duped tester list, preferring real twitch usernames
    const seen    = new Set<string>();
    const testers: Array<{ twitch: string | null; display: string }> = [];

    // Priority 1: profiles with confirmed twitch
    for (const p of (profiles ?? [])) {
      const name = String(p.twitch_username ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      testers.push({ twitch: name, display: name });
    }

    // Priority 2: approved beta signups with a twitch username filed
    for (const s of (signups ?? [])) {
      const name = String(s.twitch_username ?? "").trim();
      if (name) {
        const key = name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          testers.push({ twitch: name, display: name });
        }
        continue;
      }
      // Fall back to first-name only (no email exposed)
      const firstName = String(s.name ?? "").split(" ")[0].trim();
      if (firstName) {
        const key = "name_" + firstName.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          testers.push({ twitch: null, display: firstName });
        }
      }
    }

    return json({ testers, total: testers.length });
  } catch (err) {
    console.error("get-testers error:", err);
    return json({ error: String(err) }, 500);
  }
});
