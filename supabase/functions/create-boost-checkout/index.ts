// verify_jwt: false — auth is via license_key validation
// Creates a Stripe Checkout Session for the $5 token boost.
// license_key is validated server-side before Stripe is ever called.
// The key is stored in Stripe session metadata — never exposed in the URL.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.18.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripeSecret    = Deno.env.get("STRIPE_SECRET_KEY")       ?? "";
const boostPriceId    = Deno.env.get("STRIPE_BOOST_PRICE_ID")   ?? "";
const supabaseUrl     = Deno.env.get("SUPABASE_URL")            ?? "";
const serviceRoleKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const stripe   = new Stripe(stripeSecret, { apiVersion: "2023-10-16" });
const supabase = createClient(supabaseUrl, serviceRoleKey);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return jsonResponse({ error: "Method not allowed" }, 405);

  if (!boostPriceId) {
    console.error("STRIPE_BOOST_PRICE_ID secret is not set");
    return jsonResponse({ error: "Boost product not configured" }, 503);
  }

  let body: { license_key?: string };
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const licenseKey = body.license_key?.trim();
  if (!licenseKey) return jsonResponse({ error: "license_key is required" }, 400);

  // ── Validate license ────────────────────────────────────────────────────────
  const { data: license, error: licErr } = await supabase
    .from("licenses")
    .select("status, expires_at, tier")
    .eq("license_key", licenseKey)
    .single();

  if (licErr || !license)          return jsonResponse({ error: "License not found" }, 403);
  if (license.status !== "active") return jsonResponse({ error: "License is inactive" }, 403);
  if (license.expires_at && new Date(license.expires_at) < new Date())
    return jsonResponse({ error: "License has expired" }, 403);

  // Beta licenses are free — no need to purchase a boost
  if (license.tier === "beta") {
    return jsonResponse({ error: "Beta licenses have unlimited tokens — no boost needed" }, 400);
  }

  // ── Create Stripe Checkout Session ─────────────────────────────────────────
  const origin = req.headers.get("origin") ?? "https://www.viritts.com";

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: boostPriceId, quantity: 1 }],
    metadata: {
      license_key:   licenseKey,
      purchase_type: "token_boost",
      tokens_added:  "2000000",
    },
    success_url: `${origin}/account.html?boost=success`,
    cancel_url:  `${origin}/account.html`,
  });

  return jsonResponse({ url: session.url });
});
