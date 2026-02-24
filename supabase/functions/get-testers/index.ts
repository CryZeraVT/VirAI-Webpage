import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl    = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase       = createClient(supabaseUrl, serviceRoleKey);

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
    // Pull users who have logged token usage — these are ACTIVELY using the app.
    // Look back 30 days so the list stays fresh without being too strict.
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: usageRows, error: usageErr } = await supabase
      .from("token_usage")
      .select("twitch_channel, created_at")
      .gte("created_at", since)
      .not("twitch_channel", "is", null)
      .neq("twitch_channel", "");

    if (usageErr) throw usageErr;

    // De-dupe by twitch_channel, track most-recent usage time
    const channelMap = new Map<string, { twitch: string; lastActive: string }>();
    for (const row of (usageRows ?? [])) {
      const ch = String(row.twitch_channel ?? "").trim();
      if (!ch) continue;
      const key = ch.toLowerCase();
      const existing = channelMap.get(key);
      if (!existing || row.created_at > existing.lastActive) {
        channelMap.set(key, { twitch: ch, lastActive: row.created_at });
      }
    }

    // Sort by most recently active first
    const testers = Array.from(channelMap.values())
      .sort((a, b) => b.lastActive.localeCompare(a.lastActive))
      .map(({ twitch }) => ({ twitch, display: twitch }));

    return json({ testers, total: testers.length });
  } catch (err) {
    console.error("get-testers error:", err);
    return json({ error: String(err) }, 500);
  }
});
