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
    event = await stripe.webhooks.constructEventAsync(body, signature, stripeWebhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature error:", err);
    return jsonResponse({ error: "Invalid signature" }, 400);
  }

  // ── Subscription updated (user toggled cancel_at_period_end in the portal, etc.) ──
  // Fired on every subscription state change. We track:
  //   - cancel_at_period_end : true when user has scheduled cancellation,
  //                            false when they reactivated before period end
  //   - current_period_end   : the date their paid access runs through
  //
  // We do NOT flip licenses.status here — the subscription is still active
  // until `customer.subscription.deleted` fires at period end.
  if (event.type === "customer.subscription.updated") {
    const sub = event.data.object as Stripe.Subscription;

    const { data: purchase } = await supabase
      .from("purchases")
      .select("license_key")
      .eq("stripe_subscription_id", sub.id)
      .maybeSingle();

    const licenseKey = purchase?.license_key ?? "";
    if (licenseKey) {
      const periodEndIso = sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null;

      const { error } = await supabase
        .from("licenses")
        .update({
          cancel_at_period_end: !!sub.cancel_at_period_end,
          current_period_end: periodEndIso,
        })
        .eq("license_key", licenseKey);

      if (error) {
        console.error("Failed to update subscription state:", error);
      } else {
        console.log(
          `Subscription state updated: ${licenseKey} cancel_at_period_end=${sub.cancel_at_period_end} period_end=${periodEndIso}`
        );
      }
    } else {
      console.warn("subscription.updated: no purchase record for sub", sub.id);
    }

    return jsonResponse({ received: true });
  }

  // ── Subscription cancelled / ended ──────────────────────────────────────
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription;

    // Find the license tied to this subscription
    const { data: purchase } = await supabase
      .from("purchases")
      .select("license_key")
      .eq("stripe_subscription_id", sub.id)
      .maybeSingle();

    const licenseKey = purchase?.license_key ?? "";
    if (licenseKey) {
      const { error } = await supabase
        .from("licenses")
        .update({
          status: "inactive",
          canceled_at: new Date().toISOString(),
          cancel_at_period_end: false, // scheduled cancel has now taken effect
        })
        .eq("license_key", licenseKey);
      if (error) console.error("Failed to deactivate license on cancellation:", error);
      else console.log("License deactivated on subscription cancellation:", licenseKey);
    } else {
      console.error("subscription.deleted: no purchase record found for sub", sub.id);
    }

    return jsonResponse({ received: true });
  }

  // ── Payment failed (non-fatal — Stripe will retry) ────────────────────
  if (event.type === "invoice.payment_failed") {
    const invoice = event.data.object as Stripe.Invoice;
    const subId = typeof invoice.subscription === "string" ? invoice.subscription : null;

    if (subId) {
      const sub = await stripe.subscriptions.retrieve(subId);
      // Only deactivate if Stripe has given up retrying (status becomes past_due or canceled)
      if (sub.status === "canceled" || sub.status === "unpaid") {
        const { data: purchase } = await supabase
          .from("purchases")
          .select("license_key")
          .eq("stripe_subscription_id", subId)
          .maybeSingle();

        const licenseKey = purchase?.license_key ?? "";
        if (licenseKey) {
          await supabase.from("licenses").update({ status: "inactive" }).eq("license_key", licenseKey);
          console.log("License deactivated after payment failure:", licenseKey);
        }
      } else {
        console.log("Payment failed but Stripe still retrying — leaving license active. Sub:", subId, "status:", sub.status);
      }
    }

    return jsonResponse({ received: true });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    // ── Token boost purchase ────────────────────────────────────────────────
    if (session.metadata?.purchase_type === "token_boost") {
      const licenseKey = session.metadata.license_key ?? "";
      const tokensAdded = parseInt(session.metadata.tokens_added ?? "3000000", 10);

      if (licenseKey) {
        const { error: rpcErr } = await supabase.rpc("add_boost_tokens", {
          p_license_key: licenseKey,
          p_amount:      tokensAdded,
        });
        if (rpcErr) {
          console.error("add_boost_tokens RPC error:", rpcErr);
        }

        const { error: auditErr } = await supabase.from("boost_purchases").insert({
          license_key:       licenseKey,
          stripe_session_id: session.id,
          tokens_added:      tokensAdded,
        });
        if (auditErr) {
          console.error("boost_purchases insert error:", auditErr);
        }
      } else {
        console.error("token_boost webhook: missing license_key in metadata", session.id);
      }

      return jsonResponse({ received: true });
    }

    // ── New license purchase (subscription / one-time) ──────────────────────
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
        tier: "standard",
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
