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

// Fetch Twitch profile picture URL via the public Twitch GQL endpoint (no auth needed)
async function getTwitchAvatars(logins: string[]): Promise<Map<string, string>> {
  const avatarMap = new Map<string, string>();
  if (!logins.length) return avatarMap;

  try {
    // Use Twitch's public GQL — works without OAuth for basic user info
    const query = {
      query: `query {
        ${logins.map((l, i) => `
          u${i}: user(login: ${JSON.stringify(l)}) {
            login
            profileImageURL(width: 300)
          }
        `).join("")}
      }`
    };

    const res = await fetch("https://gql.twitch.tv/gql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko", // Twitch web client ID (public)
      },
      body: JSON.stringify(query),
    });

    if (!res.ok) return avatarMap;

    const data = await res.json();
    const gqlData = data?.data ?? {};

    logins.forEach((l, i) => {
      const user = gqlData[`u${i}`];
      if (user?.profileImageURL) {
        avatarMap.set(l.toLowerCase(), user.profileImageURL);
      }
    });
  } catch (err) {
    console.warn("Twitch GQL avatar fetch failed:", err);
  }

  return avatarMap;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Pull users who have logged token usage in the last 30 days
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

    // Sort by most recently active
    const sorted = Array.from(channelMap.values())
      .sort((a, b) => b.lastActive.localeCompare(a.lastActive));

    const logins = sorted.map(t => t.twitch);

    // Fetch avatars from Twitch GQL in one batched request
    const avatarMap = await getTwitchAvatars(logins);

    const testers = sorted.map(({ twitch }) => ({
      twitch,
      display: twitch,
      avatar: avatarMap.get(twitch.toLowerCase()) ?? null,
    }));

    return json({ testers, total: testers.length });
  } catch (err) {
    console.error("get-testers error:", err);
    return json({ error: String(err) }, 500);
  }
});
