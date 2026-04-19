// =====================================================================
// create-billing-portal-session
// =====================================================================
// Mints a Stripe Customer Portal session URL for the signed-in user.
//
// Two supported modes, both driven off the same JWT-derived identity:
//   1. No body / { flow: "manage" } (default) — general portal. Used by
//      the "Manage Subscription" button (upgrade / payment method /
//      invoices). Unchanged legacy behaviour.
//   2. { flow: "cancel" }                      — drops the user directly
//      into Stripe's cancel-confirmation flow. After the user confirms
//      (or backs out — Stripe treats both as "flow complete"), Stripe
//      auto-redirects to ``?canceled=1`` on the return URL. Used by
//      the "Cancel Subscription" link.
//
// Security model (Tier 3 — money adjacent, not money-writing):
//   - Requires a valid Supabase JWT (Authorization: Bearer <access_token>)
//   - Looks up stripe_customer_id (and for cancel, stripe_subscription_id)
//     EXCLUSIVELY by matching the caller's email against purchases.email.
//     The client cannot supply a customer id or subscription id of their
//     own choosing — both are derived server-side from the JWT.
//   - Stripe's own confirmation screen is still the real gate. Our
//     ``flow_data`` just skips the portal homepage and asks Stripe to
//     redirect after completion.
//   - Stripe portal sessions are short-lived (~1 hour) and single-use.
//   - Only writes performed are Stripe API (create session); no Supabase
//     mutations. Subscription state changes flow back via the webhook
//     (``customer.subscription.updated`` → licenses.cancel_at_period_end).
//
// Response:
//   200 { success: true,  url: "https://billing.stripe.com/p/session/..." }
//   400 { success: false, message: "Invalid flow." }
//   401 { success: false, message: "Unauthorized." }
//   404 { success: false, message: "No billing account found." }
//   404 { success: false, message: "No active subscription to cancel." }
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

  // ── Parse optional body (flow selector) ─────────────────────────────
  // Body is optional — legacy callers (Manage Subscription) post nothing.
  // Only ``flow`` is accepted; any other field is ignored defensively.
  let flow: "manage" | "cancel" = "manage";
  try {
    // Guard against empty body / non-JSON: Response.json() throws on "".
    const raw = await req.text();
    if (raw && raw.trim().length > 0) {
      const body = JSON.parse(raw);
      if (body && typeof body.flow === "string") {
        if (body.flow === "cancel" || body.flow === "manage") {
          flow = body.flow;
        } else {
          return jsonResponse({ success: false, message: "Invalid flow." }, 400);
        }
      }
    }
  } catch (_e) {
    // Malformed JSON → fall back to default manage flow rather than 400;
    // keeps legacy zero-body callers working even if a proxy injects one.
    flow = "manage";
  }

  // ── Resolve Stripe customer_id (+ subscription_id for cancel) ───────
  // We NEVER accept customer_id / subscription_id from the request body.
  // They're derived server-side from the JWT-validated email so a user
  // cannot request another user's portal session or cancel someone else's
  // subscription.
  //
  // For cancel flow we additionally filter on stripe_subscription_id so
  // the most-recent one-time boost purchase (no sub_id) doesn't shadow
  // an older still-active subscription row.
  const baseSelect = "stripe_customer_id, stripe_subscription_id, created_at";
  let query = supabase
    .from("purchases")
    .select(baseSelect)
    .ilike("email", user.email)
    .not("stripe_customer_id", "is", null);

  if (flow === "cancel") {
    query = query.not("stripe_subscription_id", "is", null);
  }

  const { data: purchases, error: lookupErr } = await query
    .order("created_at", { ascending: false })
    .limit(1);

  if (lookupErr) {
    console.error("purchases lookup failed:", lookupErr);
    return jsonResponse({ success: false, message: "Lookup failed." }, 500);
  }

  const customerId     = purchases?.[0]?.stripe_customer_id;
  const subscriptionId = purchases?.[0]?.stripe_subscription_id;

  if (!customerId) {
    return jsonResponse(
      { success: false, message: "No billing account found. If you recently purchased a subscription, please wait a minute and try again." },
      404
    );
  }

  if (flow === "cancel" && !subscriptionId) {
    // Cancel button shouldn't be visible without an active sub, but
    // defend the endpoint anyway (stale UI, direct curl, etc.).
    return jsonResponse(
      { success: false, message: "No active subscription to cancel." },
      404
    );
  }

  // ── Create portal session ───────────────────────────────────────────
  // Only the cancel flow attaches ``flow_data``. We also tack on
  // ?canceled=1 to the return URL so account.html can show a
  // confirmation banner + kick off a delayed re-fetch to wait for the
  // ``customer.subscription.updated`` webhook to land.
  try {
    const sessionParams: Stripe.BillingPortal.SessionCreateParams = {
      customer:   customerId,
      return_url: portalReturnUrl,
    };

    if (flow === "cancel") {
      const cancelReturnUrl = portalReturnUrl +
        (portalReturnUrl.includes("?") ? "&" : "?") + "canceled=1";
      sessionParams.return_url = cancelReturnUrl;
      sessionParams.flow_data = {
        type: "subscription_cancel",
        subscription_cancel: { subscription: subscriptionId! },
        after_completion: {
          type: "redirect",
          redirect: { return_url: cancelReturnUrl },
        },
      };
    }

    const session = await stripe.billingPortal.sessions.create(sessionParams);

    if (!session?.url) {
      console.error("Stripe portal session missing url:", session);
      return jsonResponse({ success: false, message: "Billing session could not be created." }, 502);
    }

    console.log(
      `Billing portal session created (flow=${flow}) for ${user.email} ` +
      `(customer=${customerId}${flow === "cancel" ? `, sub=${subscriptionId}` : ""})`
    );
    return jsonResponse({ success: true, url: session.url });
  } catch (err) {
    console.error("Stripe billingPortal.sessions.create failed:", err);
    return jsonResponse(
      { success: false, message: "Billing service unavailable. Please try again shortly." },
      502
    );
  }
});
