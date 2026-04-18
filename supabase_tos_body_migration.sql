-- ============================================================================
-- Append-only ToS body store
-- Migration: 2026-04-17 (Part 2 of the EULA / ToS work)
-- Aegis tier: 3  (legal surface + irreversible append)
--
-- Rationale:
--   Acceptance records a (surface, version) pair. To be legally defensible,
--   the TEXT of that version must never change after anyone has accepted it.
--   We therefore store the prose in an append-only table with:
--     - UPDATE and DELETE blocked by trigger (even service_role is rejected;
--       disabling the trigger is an explicit, visible act in the audit log).
--     - body_sha256 computed at insert time for integrity checks client-side.
--     - (surface, version) PK so publishing a new version is a single INSERT
--       followed by flipping site_settings.<surface>_tos_current_version.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tos_versions (
  surface       text        NOT NULL CHECK (surface IN ('app','web')),
  version       text        NOT NULL CHECK (length(trim(version)) > 0),
  body_markdown text        NOT NULL CHECK (length(trim(body_markdown)) > 0),
  body_sha256   text        NOT NULL,
  published_at  timestamptz NOT NULL DEFAULT now(),
  published_by  uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  notes         text        NULL,
  PRIMARY KEY (surface, version)
);

COMMENT ON TABLE  public.tos_versions IS
  'Immutable, append-only history of ToS/EULA text per surface. Do NOT edit rows.';
COMMENT ON COLUMN public.tos_versions.body_markdown IS
  'Canonical source text in Markdown. Clients render with their own Markdown engine.';
COMMENT ON COLUMN public.tos_versions.body_sha256  IS
  'SHA-256 of body_markdown (utf-8). Integrity check — clients MAY verify.';

-- ─── Append-only enforcement ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tos_versions_block_mutations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'tos_versions is append-only. To publish a revision, INSERT a new (surface,version) row.'
    USING ERRCODE = '55000';  -- object_not_in_prerequisite_state
END;
$$;

DROP TRIGGER IF EXISTS trg_tos_versions_no_update ON public.tos_versions;
CREATE TRIGGER trg_tos_versions_no_update
BEFORE UPDATE ON public.tos_versions
FOR EACH ROW EXECUTE FUNCTION public.tos_versions_block_mutations();

DROP TRIGGER IF EXISTS trg_tos_versions_no_delete ON public.tos_versions;
CREATE TRIGGER trg_tos_versions_no_delete
BEFORE DELETE ON public.tos_versions
FOR EACH ROW EXECUTE FUNCTION public.tos_versions_block_mutations();

-- ─── Auto-compute sha256 on insert (single source of truth) ─────────────────
CREATE OR REPLACE FUNCTION public.tos_versions_set_sha()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- encode(digest(...), 'hex') requires pgcrypto
  NEW.body_sha256 := encode(digest(convert_to(NEW.body_markdown, 'UTF8'), 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP TRIGGER IF EXISTS trg_tos_versions_set_sha ON public.tos_versions;
CREATE TRIGGER trg_tos_versions_set_sha
BEFORE INSERT ON public.tos_versions
FOR EACH ROW EXECUTE FUNCTION public.tos_versions_set_sha();

-- ─── RLS ────────────────────────────────────────────────────────────────────
-- No SELECT policies are granted to anon/authenticated. The edge function
-- reads via service_role (which bypasses RLS). Admin dashboard, if it ever
-- needs to read, should do so through a dedicated RPC or via the admin's
-- server-side role.
ALTER TABLE public.tos_versions ENABLE ROW LEVEL SECURITY;

-- Explicitly revoke write verbs from public/authenticated/anon. The triggers
-- block UPDATE/DELETE even if someone later grants them; this is belt-and-
-- suspenders.
REVOKE ALL ON TABLE public.tos_versions FROM PUBLIC;
REVOKE ALL ON TABLE public.tos_versions FROM authenticated;
REVOKE ALL ON TABLE public.tos_versions FROM anon;

-- ─── Seed initial App EULA v1.0 ─────────────────────────────────────────────
-- This row mirrors the Python placeholder in src/tos_manager.py so behavior
-- is identical whether the body comes from the server or the client fallback.
-- When the real legal copy is ready, publish by:
--     INSERT INTO public.tos_versions (surface, version, body_markdown)
--     VALUES ('app', '1.1', $$ ... new markdown ... $$);
--     UPDATE public.site_settings SET value = '1.1'
--      WHERE key = 'app_tos_current_version';
INSERT INTO public.tos_versions (surface, version, body_markdown, notes)
VALUES (
  'app',
  '1.0',
  E'# End-User License Agreement (EULA) — PLACEHOLDER\n\n'
  E'This is placeholder text for the AiRi desktop application End-User\n'
  E'License Agreement. Replace this block with the final legal copy prior\n'
  E'to public release.\n\n'
  E'## 1. Grant of License\n'
  E'Subject to the terms of this Agreement, you are granted a\n'
  E'non-exclusive, non-transferable license to use the AiRi application\n'
  E'on the machine bound to your license key.\n\n'
  E'## 2. Machine Binding\n'
  E'Your license is bound to a single machine fingerprint. Moving the\n'
  E'license to a different machine requires an explicit machine reset,\n'
  E'subject to review and anti-abuse policies.\n\n'
  E'## 3. Acceptable Use\n'
  E'You agree not to redistribute, decompile, or attempt to circumvent\n'
  E'the license validation mechanism.\n\n'
  E'## 4. Data & Privacy\n'
  E'The application transmits license validation requests, machine\n'
  E'identifiers, and usage telemetry as described in our [Privacy Policy](https://www.viritts.com).\n\n'
  E'## 5. Disclaimer of Warranty\n'
  E'The software is provided "AS IS" without warranty of any kind,\n'
  E'express or implied.\n\n'
  E'## 6. Changes\n'
  E'The operator may publish updated terms at any time. Continued use of\n'
  E'the application after a new version is published constitutes\n'
  E'acceptance.\n\n'
  E'## 7. Contact\n'
  E'For questions regarding this agreement, contact support via\n'
  E'[viritts.com](https://www.viritts.com).\n\n'
  E'---\n\n'
  E'*End of placeholder — replace before public release.*\n',
  'Initial seed at 2026-04-17. Matches Python fallback in src/tos_manager.py.'
)
ON CONFLICT (surface, version) DO NOTHING;

-- ============================================================================
-- ROLLBACK (paste into SQL editor to fully revert):
-- ============================================================================
-- DROP TRIGGER IF EXISTS trg_tos_versions_no_update  ON public.tos_versions;
-- DROP TRIGGER IF EXISTS trg_tos_versions_no_delete  ON public.tos_versions;
-- DROP TRIGGER IF EXISTS trg_tos_versions_set_sha    ON public.tos_versions;
-- DROP FUNCTION IF EXISTS public.tos_versions_block_mutations();
-- DROP FUNCTION IF EXISTS public.tos_versions_set_sha();
-- DROP TABLE    IF EXISTS public.tos_versions;
-- ============================================================================
