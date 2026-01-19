import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.18.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripeSecret = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const stripeWebhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const stripe = new Stripe(stripeSecret, { apiVersion: "2023-10-16" });
const supabase = createClient(supabaseUrl, serviceRoleKey);

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function generateLicenseKey(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let key = "VIRI-";
  for (let i = 0; i < bytes.length; i++) {
    key += chars[bytes[i] % chars.length];
    if ((i + 1) % 4 === 0 && i < bytes.length - 1) key += "-";
  }
  return key;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ received: false }, 405);
  }

  const signature = req.headers.get("stripe-signature") || "";
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, stripeWebhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature error:", err);
    return jsonResponse({ error: "Invalid signature" }, 400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    const email = session.customer_details?.email || session.customer_email || "";
    const sessionId = session.id;
    const stripeCustomerId = typeof session.customer === "string" ? session.customer : null;
    const stripeSubscriptionId = typeof session.subscription === "string" ? session.subscription : null;

    const licenseKey = generateLicenseKey();
    const downloadToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Create license (active)
    const { error: licenseError } = await supabase
      .from("licenses")
      .insert({
        license_key: licenseKey,
        email: email || null,
        status: "active",
      });

    if (licenseError) {
      console.error("Failed to insert license:", licenseError);
    }

    // Create purchase record (for download)
    const { error: purchaseError } = await supabase
      .from("purchases")
      .upsert({
        email: email || "unknown",
        stripe_session_id: sessionId,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: stripeSubscriptionId,
        license_key: licenseKey,
        download_token: downloadToken,
        expires_at: expiresAt,
      }, { onConflict: "stripe_session_id" });

    if (purchaseError) {
      console.error("Failed to insert purchase:", purchaseError);
    }
  }

  return jsonResponse({ received: true });
});
