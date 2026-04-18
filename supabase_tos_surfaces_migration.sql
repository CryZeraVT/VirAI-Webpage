-- ============================================================================
-- ToS surfaces expansion — 2026-04-17
-- ============================================================================
-- Extends the existing tos_versions + publish_tos_version machinery from
-- the single 'app' surface to three DB-driven surfaces:
--
--   • app      — In-app EULA (desktop, acceptance required per-license)
--   • web      — Website Terms of Service (acceptance required per-profile)
--   • privacy  — Privacy Notice (public notice, no acceptance tracking)
--
-- Also exposes tos_versions for anon SELECT so the public /terms and
-- /privacy pages can render the current body without a login.
--
-- Aegis tier: 2  (user-visible legal surface; not money/auth).
-- ============================================================================

-- ── 1. RPC: allow 'privacy' surface ────────────────────────────────────────
-- (app + web were already in the whitelist; we just add privacy.)
CREATE OR REPLACE FUNCTION public.publish_tos_version(
  p_surface       text,
  p_version       text,
  p_body_markdown text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller          uuid;
  v_is_admin        boolean;
  v_current_version text;
  v_sha             text;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT is_admin INTO v_is_admin FROM public.profiles WHERE id = v_caller;
  IF v_is_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'admin privilege required' USING ERRCODE = '42501';
  END IF;

  IF p_surface NOT IN ('app', 'web', 'privacy') THEN
    RAISE EXCEPTION 'surface must be app, web, or privacy' USING ERRCODE = '22023';
  END IF;

  IF p_version IS NULL OR length(trim(p_version)) = 0 THEN
    RAISE EXCEPTION 'version required' USING ERRCODE = '22023';
  END IF;

  IF p_version !~ '^\d+(\.\d+)*$' THEN
    RAISE EXCEPTION 'version must be dot-numeric (e.g. 1.0, 1.1, 2.0)'
      USING ERRCODE = '22023';
  END IF;

  IF p_body_markdown IS NULL OR length(trim(p_body_markdown)) = 0 THEN
    RAISE EXCEPTION 'body_markdown required' USING ERRCODE = '22023';
  END IF;

  IF length(p_body_markdown) > 65536 THEN
    RAISE EXCEPTION 'body_markdown exceeds 64KB cap' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tos_versions
     WHERE surface = p_surface AND version = p_version
  ) THEN
    RAISE EXCEPTION 'version % already exists for surface %', p_version, p_surface
      USING ERRCODE = '23505';
  END IF;

  -- Pointer key uses <surface>_current_version for web & privacy,
  -- but stays backward-compatible as app_tos_current_version for app.
  DECLARE
    v_key text := CASE p_surface
      WHEN 'app' THEN 'app_tos_current_version'
      ELSE p_surface || '_current_version'
    END;
  BEGIN
    SELECT value INTO v_current_version
      FROM public.site_settings
     WHERE key = v_key;

    IF v_current_version IS NOT NULL AND length(trim(v_current_version)) > 0 THEN
      IF string_to_array(p_version, '.')::int[]
           <= string_to_array(v_current_version, '.')::int[] THEN
        RAISE EXCEPTION
          'version % must be strictly greater than current %', p_version, v_current_version
          USING ERRCODE = '22023';
      END IF;
    END IF;

    INSERT INTO public.tos_versions (surface, version, body_markdown, published_by, notes)
    VALUES (
      p_surface, p_version, p_body_markdown, v_caller,
      'Published via publish_tos_version RPC'
    );

    INSERT INTO public.site_settings (key, value)
    VALUES (v_key, p_version)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  END;

  SELECT body_sha256 INTO v_sha
    FROM public.tos_versions
   WHERE surface = p_surface AND version = p_version;

  RETURN json_build_object(
    'ok',      true,
    'surface', p_surface,
    'version', p_version,
    'sha256',  v_sha
  );
END;
$$;

REVOKE ALL     ON FUNCTION public.publish_tos_version(text, text, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.publish_tos_version(text, text, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.publish_tos_version(text, text, text) TO   authenticated;

-- ── 1b. Table-level CHECK: include 'privacy' in the allowed surfaces ───────
ALTER TABLE public.tos_versions DROP CONSTRAINT IF EXISTS tos_versions_surface_check;
ALTER TABLE public.tos_versions ADD  CONSTRAINT tos_versions_surface_check
  CHECK (surface = ANY (ARRAY['app'::text, 'web'::text, 'privacy'::text]));

-- ── 2. Public SELECT on tos_versions ───────────────────────────────────────
-- Legal documents are public by design. Historical versions stay visible
-- for audit/transparency — this matches the append-only invariant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'tos_versions'
       AND policyname = 'Public can read tos_versions'
  ) THEN
    CREATE POLICY "Public can read tos_versions"
      ON public.tos_versions
      FOR SELECT
      USING (true);
  END IF;
END $$;

GRANT SELECT ON public.tos_versions TO anon, authenticated;

-- ── 3. Seed web ToS v1.0 ───────────────────────────────────────────────────
-- Ported from the TOS_PLACEHOLDER_HTML previously hardcoded in account.html.
-- Kept at version 1.0 so existing profiles.tos_version='1.0' acceptances
-- remain valid against the current published row.
INSERT INTO public.tos_versions (surface, version, body_markdown, notes)
SELECT 'web', '1.0',
$MD$# AiRi Website Terms of Service

**Effective:** Placeholder — replace before launch.
**Version:** 1.0

---

## 1. Placeholder Section — Acceptance of Terms

By creating an account or continuing to use AiRi (the "Service"), provided by VirForge, you agree to be bound by these Terms of Service. *Replace this paragraph with your finalised acceptance clause.*

## 2. Placeholder Section — Eligibility & Account

You must be at least the age of majority in your jurisdiction, and you are responsible for the security of your credentials and all activity under your account. *Replace with final account-use terms.*

## 3. Placeholder Section — Acceptable Use

You agree not to misuse the Service, including by violating applicable law, infringing others' rights, or attempting to probe, scan, or reverse-engineer the platform outside of authorised research channels. *Replace with the finalised acceptable-use clause.*

## 4. Placeholder Section — AI Output & Third-Party Models

AiRi may route requests through third-party AI providers. Generated output is provided on an "as is" basis; you are responsible for reviewing anything you publish publicly. *Replace with final AI/usage clause.*

## 5. Placeholder Section — Subscription, Billing & Refunds

Paid tiers are billed through our payment processor. Cancellations and refund eligibility are described at [viritts.com/buy](https://viritts.com/buy.html). *Replace with final billing/refund clause.*

## 6. Placeholder Section — Privacy

Our handling of personal data is described in the [Privacy Notice](https://viritts.com/privacy.html). *Replace with final privacy cross-reference.*

## 7. Placeholder Section — Termination

We may suspend or terminate access for breach of these Terms. You may close your account at any time from the Account page. *Replace with final termination clause.*

## 8. Placeholder Section — Disclaimers & Limitation of Liability

The Service is provided "as is" without warranties of any kind. To the fullest extent permitted by law, VirForge is not liable for indirect or consequential damages. *Replace with final disclaimer/limitation clause.*

## 9. Placeholder Section — Changes

We may update these Terms. Material changes will trigger a re-acceptance prompt the next time you sign in. *Replace with final change-of-terms clause.*

## 10. Placeholder Section — Contact

Questions? *Replace with final contact details / governing-law clause.*

---

**End of Terms — v1.0.** By creating an account you confirm you have read and accept these Terms.
$MD$,
'Initial seed — ported from legacy hardcoded TOS_PLACEHOLDER_HTML in account.html.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.tos_versions WHERE surface = 'web' AND version = '1.0'
);

INSERT INTO public.site_settings (key, value)
VALUES ('web_current_version', '1.0')
ON CONFLICT (key) DO NOTHING;

-- ── 4. Seed privacy notice v1.0 ────────────────────────────────────────────
INSERT INTO public.tos_versions (surface, version, body_markdown, notes)
SELECT 'privacy', '1.0',
$MD$# AiRi Privacy Notice

**Effective:** Placeholder — replace before launch.
**Version:** 1.0

---

## 1. Who We Are

AiRi is operated by VirForge. This notice explains what personal data we collect, why, and your rights regarding it. *Replace with final controller / contact details.*

## 2. Data We Collect

- **Account data:** email address, hashed password, optional Twitch handle.
- **Licensing:** license key, binding machine ID (one per license).
- **Usage:** request counts, quota consumption, error logs (no prompt/response bodies stored by default).
- **Billing:** handled by Stripe; we receive transaction metadata (no full card numbers).

*Replace with final data-inventory clause.*

## 3. Why We Process It

- To provide and secure the Service (contractual basis).
- To enforce license quotas and fraud protection (legitimate interest).
- To process payments (contractual basis, via Stripe).
- To communicate service updates you have opted in to (consent).

*Replace with final lawful-basis clause.*

## 4. Third Parties

We share data strictly with:

- [Stripe](https://stripe.com) — payment processing.
- [Supabase](https://supabase.com) — authentication + database hosting.
- AI model providers — only the content of individual requests you initiate, for response generation.

*Replace with final sub-processor list + links to their policies.*

## 5. Retention

Account data is retained while the account is active and for a limited period after closure for legal/tax purposes. Usage logs roll off on a fixed schedule. *Replace with final retention periods.*

## 6. Your Rights

You may:

- Access or export your data.
- Request correction or deletion.
- Withdraw consent (where consent is the basis).
- Lodge a complaint with your local supervisory authority.

Submit requests via [support@viriflowsocial.com](mailto:support@viriflowsocial.com). *Replace with final DSAR contact.*

## 7. Cookies & Local Storage

The site uses local storage for session persistence and preferences. No third-party advertising cookies are set by us. *Replace with final cookie disclosure.*

## 8. Children

The Service is not directed at children under the age of majority in their jurisdiction. *Replace with final minors clause.*

## 9. Changes

We will update this notice when practices change; the effective date and version will update here. This is a **notice**, not a contract — continued use implies you have read it.

## 10. Contact

Questions or requests: [support@viriflowsocial.com](mailto:support@viriflowsocial.com). *Replace with final DPO contact.*

---

**Privacy Notice v1.0** — This document is informational. No checkbox acceptance is recorded.
$MD$,
'Initial seed — placeholder privacy notice.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.tos_versions WHERE surface = 'privacy' AND version = '1.0'
);

INSERT INTO public.site_settings (key, value)
VALUES ('privacy_current_version', '1.0')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- ROLLBACK:
--   -- 1) Restore RPC to app-only:
--   --    (paste previous CREATE OR REPLACE from supabase_tos_publish_rpc.sql)
--   -- 2) Drop anon/auth SELECT:
--   --    REVOKE SELECT ON public.tos_versions FROM anon, authenticated;
--   --    DROP POLICY IF EXISTS "Public can read tos_versions" ON public.tos_versions;
--   -- 3) Seed rows are append-only — they cannot be deleted once inserted.
--   --    If you need to retire them, set a higher version and flip the pointer.
-- ============================================================================
