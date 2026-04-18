// =====================================================================
// create-billing-portal-session
// =====================================================================
// Mints a Stripe Customer Portal session URL for the signed-in user.
//
// Security model (Tier 3 — money adjacent, not money-writing):
//   - Requires a valid Supabase JWT (Authorization: Bearer <access_token>)
//   - Looks up stripe_customer_id EXCLUSIVELY by matching the caller's
//     email against purchases.email. The client cannot supply a customer
//     id of their own choosing — it's derived server-side from the JWT.
//   - Stripe portal sessions are short-lived (~1 hour) and single-use.
//   - Only writes performed are Stripe API (create session); no Supabase
//     mutations. Subscription state changes flow back via the webhook.
//
// Response:
//   200 { success: true,  url: "https://billing.stripe.com/p/session/..." }
//   401 { success: false, message: "Unauthorized." }
//   404 { success: false, message: "No billing account found." }
//   502 { success: false, message: "Billing service unavailable." }
// =====================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.18.0?target=deno";
// Pinned: older supabase-js cannot decode ES256-signed JWTs after the
// Supabase asymmetric key migration (see issues #42244 / #42755).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.3";

const stripeSecret   = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const supabaseUrl    = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const portalReturnUrl =
  Deno.env.get("STRIPE_PORTAL_RETURN_URL") ?? "https://viritts.com/account.html";

const stripe   = new Stripe(stripeSecret, { apiVersion: "2023-10-16" });
const supabase = createClient(supabaseUrl, serviceRoleKey);

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, message: "Method not allowed." }, 405);
  }

  // ── Auth ────────────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ success: false, message: "Missing Authorization header." }, 401);
  }

  const { data: { user }, error: userError } = await supabase.auth.getUser(
    authHeader.replace("Bearer ", "")
  );
  if (userError || !user || !user.email) {
    return jsonResponse({ success: false, message: "Unauthorized." }, 401);
  }

  // ── Resolve Stripe customer_id from the caller's email ──────────────
  // We NEVER accept customer_id from the request body. It's derived
  // server-side from the JWT-validated email so a user cannot request
  // another user's portal session.
  //
  // A user may have multiple purchases rows (subscription + one-time
  // boosts) — pick the most recent one with a stripe_customer_id.
  const { data: purchases, error: lookupErr } = await supabase
    .from("purchases")
    .select("stripe_customer_id, created_at")
    .ilike("email", user.email)
    .not("stripe_customer_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);

  if (lookupErr) {
    console.error("purchases lookup failed:", lookupErr);
    return jsonResponse({ success: false, message: "Lookup failed." }, 500);
  }

  const customerId = purchases?.[0]?.stripe_customer_id;
  if (!customerId) {
    return jsonResponse(
      { success: false, message: "No billing account found. If you recently purchased a subscription, please wait a minute and try again." },
      404
    );
  }

  // ── Create portal session ───────────────────────────────────────────
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: portalReturnUrl,
    });

    if (!session?.url) {
      console.error("Stripe portal session missing url:", session);
      return jsonResponse({ success: false, message: "Billing session could not be created." }, 502);
    }

    console.log(`Billing portal session created for ${user.email} (customer=${customerId})`);
    return jsonResponse({ success: true, url: session.url });
  } catch (err) {
    console.error("Stripe billingPortal.sessions.create failed:", err);
    return jsonResponse(
      { success: false, message: "Billing service unavailable. Please try again shortly." },
      502
    );
  }
});
