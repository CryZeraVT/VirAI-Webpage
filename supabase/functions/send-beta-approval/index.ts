import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SITE_URL = "https://viritts.com";

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

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

async function userExistsByEmail(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  const pageSize = 200;
  let page = 1;
  while (page <= 20) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: pageSize });
    if (error) break;
    const users = data?.users ?? [];
    if (users.some((u) => (u.email ?? "").toLowerCase() === normalized)) return true;
    if (users.length < pageSize) break;
    page += 1;
  }
  return false;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: { name: string; email: string; license_key: string; expires_at: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const { name, email, license_key, expires_at } = body;

  if (!name?.trim() || !email?.trim() || !license_key?.trim()) {
    return jsonResponse({ error: "name, email, and license_key are required." }, 400);
  }

  const cleanEmail = email.trim();
  const cleanName = name.trim();
  const expiryStr = expires_at
    ? new Date(expires_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : "30 days from now";

  const alreadyExists = await userExistsByEmail(cleanEmail);

  let actionLink: string | null = null;
  let inviteError: string | null = null;

  if (alreadyExists) {
    // Existing user — generate a magic link (Supabase sends this via its built-in email)
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: "magiclink",
      email: cleanEmail,
      options: { redirectTo: `${SITE_URL}/account.html` },
    });
    if (linkErr) {
      console.error("generateLink error:", linkErr.message);
      inviteError = linkErr.message;
    } else {
      actionLink = linkData?.properties?.action_link ?? null;
    }
  } else {
    // New user — Supabase sends them an invite email automatically
    const { data: inviteData, error: invErr } = await supabase.auth.admin.inviteUserByEmail(
      cleanEmail,
      { redirectTo: `${SITE_URL}/account.html` }
    );
    if (invErr) {
      console.error("inviteUserByEmail error:", invErr.message);
      inviteError = invErr.message;
    } else {
      actionLink = inviteData?.user?.action_link ?? null;
    }
  }

  // If invite/magic-link both failed, return an error
  if (inviteError && !actionLink) {
    return jsonResponse({
      success: false,
      already_exists: alreadyExists,
      action_link: null,
      error: `Failed to send email: ${inviteError}`,
    }, 500);
  }

  // Success — Supabase has sent the email. Return the action link so the
  // admin panel can display it as a fallback if the user doesn't get the email.
  return jsonResponse({
    success: true,
    already_exists: alreadyExists,
    action_link: actionLink,
    invite_error: inviteError ?? null,
    // Pass back a summary so the admin alert shows useful info
    license_key,
    expires: expiryStr,
    name: cleanName,
  });
});
