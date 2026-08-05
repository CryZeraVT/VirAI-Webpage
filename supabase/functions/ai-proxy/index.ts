// verify_jwt: false — auth is via license_key
// config_key selects which system_config row to use:
//   "builtin_ai_provider"  → legacy testers
//   "proxy_ai_provider"    → new prod users (default)
// max_tokens: optional per-request override (dynamic from persona word limit)
//
// Tier token limits are read from system_config key='tier_limits' with an
// in-memory 60s cache. Admin edits propagate within a minute. Falls back
// to hardcoded TIER_LIMITS_FALLBACK if the row is missing or malformed so
// config drift can never break live service.
//
// Failover: system_config key='ai_failover_chains' (or in-code fallback):
//   Core (standard/test): Gemini → OpenAI → Grok
//   Studio (studio/beta): Grok → OpenAI → Gemini
// Admin probe: header x-airi-admin-probe must match AIRI_ADMIN_PROBE_SECRET
//   to allow test_api_key / test_provider / force_failover / chain_override.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl    = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ADMIN_PROBE_SECRET = Deno.env.get("AIRI_ADMIN_PROBE_SECRET") ?? "";

const ALLOWED_CONFIG_KEYS = ["builtin_ai_provider", "proxy_ai_provider", "studio_ai_provider"] as const;
type ConfigKey = typeof ALLOWED_CONFIG_KEYS[number];

type AiCfg = {
  provider?: string; model?: string;
  temperature?: number; max_tokens?: number; max_completion_tokens?: number;
  top_p?: number; frequency_penalty?: number; presence_penalty?: number;
  reasoning_effort?: string;
};

type FailoverHop = { provider: string; model: string };
type FailoverChains = {
  core: FailoverHop[];
  studio: FailoverHop[];
  retryable_status: number[];
  hop_timeout_ms: number;
};

type AttemptRecord = {
  provider: string;
  model: string;
  status: number | string;
  error?: string;
};

type HopResult = {
  ok: boolean;
  retryable: boolean;
  status: number | string;
  content: string;
  promptTokens: number;
  completionTokens: number;
  error?: string;
};

const MODEL_DEFAULTS: Record<string, string> = {
  openai: "gpt-4o-mini",
  grok:   "grok-3",
  gemini: "gemini-2.5-flash",
};

// Safe fallback used if system_config is missing/malformed. Must stay in
// sync with the DB seed in the tier_limits_system_config migration.
const TIER_LIMITS_FALLBACK: Record<string, number> = {
  standard: 3_000_000,
  studio:   6_000_000,
  test:     50_000,
  // beta: no entry — beta bypasses quota enforcement entirely
};

const FAILOVER_CHAINS_FALLBACK: FailoverChains = {
  core: [
    { provider: "gemini", model: "" },
    { provider: "openai", model: "gpt-4o-mini" },
    { provider: "grok", model: "grok-3" },
  ],
  studio: [
    { provider: "grok", model: "" },
    { provider: "openai", model: "gpt-4o-mini" },
    { provider: "gemini", model: "gemini-2.5-flash" },
  ],
  retryable_status: [429, 500, 502, 503, 504],
  hop_timeout_ms: 20_000,
};

// In-memory cache: process-local, refreshed every 60s. Edge Function
// instances are short-lived so this is fine; worst case a change takes
// ~60s per warm instance to propagate.
let TIER_LIMITS_CACHE: Record<string, number> = { ...TIER_LIMITS_FALLBACK };
let TIER_LIMITS_CACHE_AT = 0;
const TIER_CACHE_TTL_MS = 60_000;

let FAILOVER_CACHE: FailoverChains = structuredClone(FAILOVER_CHAINS_FALLBACK);
let FAILOVER_CACHE_AT = 0;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-airi-admin-probe",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function isReasoningModel(provider: string, model: string): boolean {
  const m = model.toLowerCase();
  if (provider === "grok" && m.includes("grok-4") && !m.includes("non-reasoning")) return true;
  if (provider === "openai" && (m.includes("gpt-5") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4"))) return true;
  return false;
}

function normalizeProvider(p: unknown): string {
  return String(p ?? "").trim().toLowerCase();
}

function isInfraErrorBody(text: string): boolean {
  const t = (text || "").toLowerCase();
  const needles = [
    "permission-denied",
    "spending limit",
    "available credits",
    "purchase more credits",
    "monthly spending",
    "used all available credits",
    "raise its spending limit",
    "raise your spending limit",
    "resource_exhausted",
    "quota exceeded",
    "rate limit",
    "too many requests",
    "overloaded",
    "service unavailable",
    "temporarily unavailable",
  ];
  return needles.some((n) => t.includes(n));
}

function isRetryableProviderFailure(
  status: number | string,
  errText: string,
  retryableStatus: number[],
): boolean {
  if (status === "timeout" || status === "network" || status === "missing_key" || status === "forced") {
    return true;
  }
  const code = typeof status === "number" ? status : Number(status);
  if (Number.isFinite(code) && retryableStatus.includes(code)) return true;
  if (Number.isFinite(code) && (code === 401 || code === 403) && isInfraErrorBody(errText)) return true;
  if (isInfraErrorBody(errText)) return true;
  return false;
}

function sanitizeHop(raw: unknown): FailoverHop | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const provider = normalizeProvider(o.provider);
  if (!["gemini", "openai", "grok"].includes(provider)) return null;
  const model = typeof o.model === "string" ? o.model.trim() : "";
  return { provider, model };
}

function parseFailoverChains(value: unknown): FailoverChains | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const coreRaw = Array.isArray(v.core) ? v.core : null;
  const studioRaw = Array.isArray(v.studio) ? v.studio : null;
  if (!coreRaw || !studioRaw) return null;
  const core = coreRaw.map(sanitizeHop).filter((h): h is FailoverHop => !!h);
  const studio = studioRaw.map(sanitizeHop).filter((h): h is FailoverHop => !!h);
  if (core.length === 0 || studio.length === 0) return null;
  const retryable = Array.isArray(v.retryable_status)
    ? v.retryable_status.map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : FAILOVER_CHAINS_FALLBACK.retryable_status;
  const hopTimeout = Number(v.hop_timeout_ms);
  return {
    core,
    studio,
    retryable_status: retryable.length ? retryable : FAILOVER_CHAINS_FALLBACK.retryable_status,
    hop_timeout_ms: Number.isFinite(hopTimeout) && hopTimeout > 0
      ? hopTimeout
      : FAILOVER_CHAINS_FALLBACK.hop_timeout_ms,
  };
}

async function getTierLimits(sb: SupabaseClient): Promise<Record<string, number>> {
  const now = Date.now();
  if (now - TIER_LIMITS_CACHE_AT < TIER_CACHE_TTL_MS) return TIER_LIMITS_CACHE;
  try {
    const { data, error } = await sb
      .from("system_config")
      .select("value")
      .eq("key", "tier_limits")
      .maybeSingle();
    if (error) throw error;
    if (data?.value && typeof data.value === "object") {
      const parsed: Record<string, number> = {};
      for (const [k, v] of Object.entries(data.value as Record<string, unknown>)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) parsed[k] = n;
      }
      if (Object.keys(parsed).length > 0) {
        TIER_LIMITS_CACHE = parsed;
        TIER_LIMITS_CACHE_AT = now;
      }
    }
  } catch (e) {
    console.error("tier_limits read failed, using cached/default:", e);
  }
  return TIER_LIMITS_CACHE;
}

async function getFailoverChains(sb: SupabaseClient): Promise<FailoverChains> {
  const now = Date.now();
  if (now - FAILOVER_CACHE_AT < TIER_CACHE_TTL_MS) return FAILOVER_CACHE;
  try {
    const { data, error } = await sb
      .from("system_config")
      .select("value")
      .eq("key", "ai_failover_chains")
      .maybeSingle();
    if (error) throw error;
    const parsed = parseFailoverChains(data?.value);
    if (parsed) {
      FAILOVER_CACHE = parsed;
      FAILOVER_CACHE_AT = now;
    }
  } catch (e) {
    console.error("ai_failover_chains read failed, using cached/default:", e);
  }
  return FAILOVER_CACHE;
}

function sanitizeModelId(raw: unknown, fallback: string): string {
  // DB values are data, not code. Whitelist model id charset so a tampered
  // system_config row cannot smuggle path/query junk into provider URLs.
  const s = String(raw ?? "").trim();
  if (!s) return fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s)) return fallback;
  return s;
}

function resolveHopModel(
  hop: FailoverHop,
  hopIndex: number,
  primaryCfg: AiCfg,
): string {
  const fallback = MODEL_DEFAULTS[hop.provider] ?? "gpt-4o-mini";
  if (hop.model && hop.model.trim()) return sanitizeModelId(hop.model, fallback);
  const primaryProvider = normalizeProvider(primaryCfg.provider);
  const primaryModel = (primaryCfg.model && primaryCfg.model.trim()) ? primaryCfg.model.trim() : "";
  if (hopIndex === 0 && primaryModel && (!primaryProvider || primaryProvider === hop.provider)) {
    return sanitizeModelId(primaryModel, fallback);
  }
  if (primaryModel && primaryProvider === hop.provider) return sanitizeModelId(primaryModel, fallback);
  return fallback;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callGeminiHop(opts: {
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  cfg: AiCfg;
  requestMaxTokens: number | null;
  timeoutMs: number;
  retryableStatus: number[];
}): Promise<HopResult> {
  const geminiModel = opts.model || "gemini-2.5-flash";
  const geminiUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${opts.apiKey}`;

  const systemParts: Array<{ text: string }> = [];
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  for (const msg of opts.messages) {
    if (msg.role === "system") systemParts.push({ text: msg.content });
    else {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      });
    }
  }

  const maxOut = opts.requestMaxTokens ?? opts.cfg.max_tokens ?? 300;
  const geminiPayload: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: opts.cfg.temperature ?? 0.9,
      topP: opts.cfg.top_p ?? 0.95,
      maxOutputTokens: Math.max(maxOut, 2048),
    },
  };
  if (systemParts.length > 0) {
    geminiPayload["systemInstruction"] = { parts: systemParts };
  }

  try {
    const geminiRes = await fetchWithTimeout(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiPayload),
    }, opts.timeoutMs);

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return {
        ok: false,
        retryable: isRetryableProviderFailure(geminiRes.status, errText, opts.retryableStatus),
        status: geminiRes.status,
        content: "",
        promptTokens: 0,
        completionTokens: 0,
        error: `Gemini error (${geminiRes.status}): ${errText.slice(0, 500)}`,
      };
    }

    const geminiData = await geminiRes.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    return {
      ok: true,
      retryable: false,
      status: 200,
      content: geminiData.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
      promptTokens: geminiData.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: geminiData.usageMetadata?.candidatesTokenCount ?? 0,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = /abort/i.test(msg);
    return {
      ok: false,
      retryable: true,
      status: timedOut ? "timeout" : "network",
      content: "",
      promptTokens: 0,
      completionTokens: 0,
      error: `Gemini ${timedOut ? "timeout" : "network"}: ${msg}`,
    };
  }
}

async function callOpenAiCompatibleHop(opts: {
  provider: "openai" | "grok";
  apiKey: string;
  model: string;
  messages: unknown[];
  cfg: AiCfg;
  requestMaxTokens: number | null;
  timeoutMs: number;
  retryableStatus: number[];
}): Promise<HopResult> {
  const apiUrl = opts.provider === "openai"
    ? "https://api.openai.com/v1/chat/completions"
    : "https://api.x.ai/v1/chat/completions";
  const reasoning = isReasoningModel(opts.provider, opts.model);
  const aiPayload: Record<string, unknown> = { model: opts.model, messages: opts.messages };

  if (reasoning) {
    aiPayload["max_completion_tokens"] = opts.cfg.max_completion_tokens ?? 2000;
    if (opts.provider === "grok") {
      aiPayload["reasoning_effort"] = opts.cfg.reasoning_effort ?? "low";
    }
  } else if (opts.provider === "grok") {
    aiPayload["temperature"] = opts.cfg.temperature ?? 0.9;
    aiPayload["max_tokens"] = opts.requestMaxTokens ?? opts.cfg.max_tokens ?? 300;
    aiPayload["top_p"] = opts.cfg.top_p ?? 0.95;
  } else {
    aiPayload["temperature"] = opts.cfg.temperature ?? 0.9;
    aiPayload["max_tokens"] = opts.requestMaxTokens ?? opts.cfg.max_tokens ?? 300;
    aiPayload["top_p"] = opts.cfg.top_p ?? 1.0;
    aiPayload["frequency_penalty"] = opts.cfg.frequency_penalty ?? 0.3;
    aiPayload["presence_penalty"] = opts.cfg.presence_penalty ?? 0.3;
  }

  try {
    const aiRes = await fetchWithTimeout(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(aiPayload),
    }, opts.timeoutMs);

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return {
        ok: false,
        retryable: isRetryableProviderFailure(aiRes.status, errText, opts.retryableStatus),
        status: aiRes.status,
        content: "",
        promptTokens: 0,
        completionTokens: 0,
        error: `AI provider error (${aiRes.status}): ${errText.slice(0, 500)}`,
      };
    }

    const aiData = await aiRes.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    return {
      ok: true,
      retryable: false,
      status: 200,
      content: aiData.choices?.[0]?.message?.content ?? "",
      promptTokens: aiData.usage?.prompt_tokens ?? 0,
      completionTokens: aiData.usage?.completion_tokens ?? 0,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = /abort/i.test(msg);
    return {
      ok: false,
      retryable: true,
      status: timedOut ? "timeout" : "network",
      content: "",
      promptTokens: 0,
      completionTokens: 0,
      error: `${opts.provider} ${timedOut ? "timeout" : "network"}: ${msg}`,
    };
  }
}

async function callProviderHop(opts: {
  provider: string;
  model: string;
  apiKey: string;
  messages: Array<{ role: string; content: string }>;
  cfg: AiCfg;
  requestMaxTokens: number | null;
  timeoutMs: number;
  retryableStatus: number[];
}): Promise<HopResult> {
  if (opts.provider === "gemini") {
    return callGeminiHop({
      apiKey: opts.apiKey,
      model: opts.model,
      messages: opts.messages,
      cfg: opts.cfg,
      requestMaxTokens: opts.requestMaxTokens,
      timeoutMs: opts.timeoutMs,
      retryableStatus: opts.retryableStatus,
    });
  }
  if (opts.provider === "openai" || opts.provider === "grok") {
    return callOpenAiCompatibleHop({
      provider: opts.provider,
      apiKey: opts.apiKey,
      model: opts.model,
      messages: opts.messages,
      cfg: opts.cfg,
      requestMaxTokens: opts.requestMaxTokens,
      timeoutMs: opts.timeoutMs,
      retryableStatus: opts.retryableStatus,
    });
  }
  return {
    ok: false,
    retryable: false,
    status: 400,
    content: "",
    promptTokens: 0,
    completionTokens: 0,
    error: `Unknown provider: ${opts.provider}`,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let body: {
    messages?: unknown[];
    license_key?: string;
    twitch_channel?: string;
    config_key?: string;
    max_tokens?: number;
    test_api_key?: string;
    test_provider?: string;
    force_failover?: boolean;
    chain_override?: string;
  };
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0)
    return jsonResponse({ error: "messages array is required" }, 400);

  const { messages, license_key, twitch_channel } = body;

  const rawKey = (body.config_key ?? "proxy_ai_provider").trim();
  const configKey: ConfigKey = (ALLOWED_CONFIG_KEYS as readonly string[]).includes(rawKey)
    ? rawKey as ConfigKey
    : "proxy_ai_provider";

  const requestMaxTokens = (typeof body.max_tokens === "number" && body.max_tokens > 0)
    ? Math.min(body.max_tokens, 2000)
    : null;

  if (!license_key?.trim())
    return jsonResponse({ error: "license_key is required" }, 401);

  const trimmedKey = license_key.trim();
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Admin probe gate (never honor test key / force_failover without secret).
  const probeHeader = req.headers.get("x-airi-admin-probe") ?? "";
  const probeAuthorized = !!(
    ADMIN_PROBE_SECRET &&
    probeHeader &&
    probeHeader === ADMIN_PROBE_SECRET
  );
  if (!probeAuthorized && (body.test_api_key || body.force_failover || body.chain_override)) {
    // Ignore probe fields silently for normal clients (no new attack surface messaging).
  }

  // ── Validate license + read tier ─────────────────────────────────────
  const { data: license, error: licError } = await supabase
    .from("licenses")
    .select("status, expires_at, tier")
    .eq("license_key", trimmedKey)
    .single();

  if (licError || !license) return jsonResponse({ error: "License not found" }, 403);
  if (license.status !== "active") return jsonResponse({ error: "License is inactive" }, 403);
  if (license.expires_at && new Date(license.expires_at) < new Date())
    return jsonResponse({ error: "License has expired" }, 403);

  const tier = (license.tier ?? "standard") as string;
  const isBeta = tier === "beta";

  const tierLimits = await getTierLimits(supabase);
  const tierLimit = tierLimits[tier] ?? tierLimits.standard ?? TIER_LIMITS_FALLBACK.standard;

  // ── Tier → config key mapping ─────────────────────────────────────────
  const effectiveConfigKey: ConfigKey =
    (tier === "studio" || tier === "beta") ? "studio_ai_provider" :
    configKey === "builtin_ai_provider" ? "builtin_ai_provider" :
    "proxy_ai_provider";

  // ── Quota pre-check (non-beta tiers only) ────────────────────────────
  if (!isBeta) {
    const { data: quota } = await supabase
      .from("token_quotas")
      .select("tokens_used, boost_tokens_remaining, base_limit, period_end")
      .eq("license_key", trimmedKey)
      .maybeSingle();

    if (quota) {
      const periodExpired = new Date(quota.period_end) <= new Date();
      const baseExhausted = quota.tokens_used >= tierLimit;
      const boostEmpty = quota.boost_tokens_remaining <= 0;

      if (!periodExpired && baseExhausted && boostEmpty) {
        return jsonResponse({
          error: "quota_exceeded",
          quota_blocked: true,
          tokens_used: quota.tokens_used,
          base_limit: tierLimit,
          quota_percent: 100,
          boost_remaining: 0,
          tier,
        }, 429);
      }
    }
  }

  // ── Read AI config + keys + failover chains ───────────────────────────
  const { data: aiConfig } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", effectiveConfigKey)
    .maybeSingle();
  const cfg = (aiConfig?.value ?? {}) as AiCfg;

  // Also load the other primary so hop-0 empty model can resolve correctly
  // when chain_override differs from license tier.
  const { data: proxyPrimary } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", "proxy_ai_provider")
    .maybeSingle();
  const { data: studioPrimary } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", "studio_ai_provider")
    .maybeSingle();

  const { data: apiKeysConfig } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", "ai_api_keys")
    .maybeSingle();
  const apiKeys = (apiKeysConfig?.value ?? {}) as Record<string, string>;

  const chains = await getFailoverChains(supabase);

  let chainName: "core" | "studio" =
    (tier === "studio" || tier === "beta") ? "studio" : "core";
  if (probeAuthorized) {
    const ov = String(body.chain_override ?? "").trim().toLowerCase();
    if (ov === "core" || ov === "studio") chainName = ov;
  }

  const hopList = chainName === "studio" ? chains.studio : chains.core;
  const primaryForChain = (
    chainName === "studio"
      ? (studioPrimary?.value ?? cfg)
      : (proxyPrimary?.value ?? cfg)
  ) as AiCfg;

  const typedMessages = messages as Array<{ role: string; content: string }>;
  const attempted: AttemptRecord[] = [];
  let winner: {
    provider: string;
    model: string;
    content: string;
    promptTokens: number;
    completionTokens: number;
    reasoning: boolean;
  } | null = null;
  let lastError = "All failover hops failed";
  let lastStatus = 503;

  const forceFailover = probeAuthorized && !!body.force_failover;
  const testProvider = probeAuthorized ? normalizeProvider(body.test_provider) : "";
  const testApiKey = probeAuthorized && typeof body.test_api_key === "string"
    ? body.test_api_key.trim()
    : "";

  for (let i = 0; i < hopList.length; i++) {
    const hop = hopList[i];
    const model = resolveHopModel(hop, i, primaryForChain);
    const reasoning = isReasoningModel(hop.provider, model);

    let apiKey = apiKeys[hop.provider] ?? "";
    if (testApiKey && testProvider === hop.provider) {
      apiKey = testApiKey;
    }

    if (forceFailover && i === 0) {
      const rec: AttemptRecord = {
        provider: hop.provider,
        model,
        status: "forced",
        error: "force_failover: hop 0 skipped for probe",
      };
      attempted.push(rec);
      console.log(JSON.stringify({
        event: "ai_proxy_hop",
        license_tier: tier,
        chain: chainName,
        hop: i,
        ...rec,
      }));
      continue;
    }

    if (!apiKey) {
      const rec: AttemptRecord = {
        provider: hop.provider,
        model,
        status: "missing_key",
        error: `No API key configured for provider: ${hop.provider}`,
      };
      attempted.push(rec);
      console.log(JSON.stringify({
        event: "ai_proxy_hop",
        license_tier: tier,
        chain: chainName,
        hop: i,
        ...rec,
      }));
      lastError = rec.error!;
      lastStatus = 503;
      continue;
    }

    const result = await callProviderHop({
      provider: hop.provider,
      model,
      apiKey,
      messages: typedMessages,
      cfg: primaryForChain,
      requestMaxTokens,
      timeoutMs: chains.hop_timeout_ms,
      retryableStatus: chains.retryable_status,
    });

    const rec: AttemptRecord = {
      provider: hop.provider,
      model,
      status: result.status,
      error: result.ok ? undefined : (result.error ?? "hop failed"),
    };
    attempted.push(rec);
    console.log(JSON.stringify({
      event: "ai_proxy_hop",
      license_tier: tier,
      chain: chainName,
      hop: i,
      ok: result.ok,
      retryable: result.retryable,
      ...rec,
    }));

    if (result.ok) {
      winner = {
        provider: hop.provider,
        model,
        content: result.content,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        reasoning,
      };
      break;
    }

    lastError = result.error ?? lastError;
    lastStatus = typeof result.status === "number" ? result.status : 503;
    if (!result.retryable) break;
  }

  if (!winner) {
    return jsonResponse({
      error: lastError,
      tier,
      chain: chainName,
      failover_used: attempted.length > 1,
      attempted,
    }, typeof lastStatus === "number" ? lastStatus : 503);
  }

  const provider = winner.provider;
  const model = winner.model;
  const responseContent = winner.content;
  const promptTokens = winner.promptTokens;
  const completionTokens = winner.completionTokens;
  const reasoning = winner.reasoning;
  const failoverUsed = attempted.length > 1 ||
    (attempted.length === 1 && attempted[0].provider !== normalizeProvider(primaryForChain.provider));

  // ── Track usage (always, for analytics) ──────────────────────────────
  const totalTokens = promptTokens + completionTokens;

  if (totalTokens > 0) {
    const { data: pricing } = await supabase
      .from("model_pricing")
      .select("input_cost_per_million, output_cost_per_million")
      .eq("provider", provider).eq("model", model)
      .maybeSingle();

    type P = { input_cost_per_million: number; output_cost_per_million: number };
    const pr = pricing as P | null;
    const cost = pr
      ? (promptTokens / 1_000_000) * Number(pr.input_cost_per_million)
      + (completionTokens / 1_000_000) * Number(pr.output_cost_per_million)
      : 0;

    await supabase.from("token_usage").insert({
      license_key: trimmedKey,
      provider, model, prompt_tokens: promptTokens, completion_tokens: completionTokens,
      cost_usd: cost,
      twitch_channel: twitch_channel ?? null,
    });
  }

  // ── Quota post-increment (non-beta tiers only) ───────────────────────
  let quotaInfo: Record<string, unknown> = {};

  if (!isBeta && totalTokens > 0) {
    const { data: quotaResult, error: rpcErr } = await supabase.rpc("increment_token_quota", {
      p_license_key: trimmedKey,
      p_tokens: totalTokens,
      p_license_active: license.status === "active",
      p_base_limit: tierLimit,
    });

    if (!rpcErr && quotaResult) {
      quotaInfo = {
        tier,
        quota_used: quotaResult.tokens_used,
        quota_limit: quotaResult.base_limit,
        quota_percent: quotaResult.quota_percent,
        quota_blocked: !quotaResult.allowed,
        using_boost: quotaResult.using_boost,
        boost_remaining: quotaResult.boost_remaining,
      };
    }
  } else if (isBeta) {
    quotaInfo = { tier: "beta" };
  }

  return jsonResponse({
    content: responseContent,
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    model, provider, reasoning,
    config_key: effectiveConfigKey,
    tier,
    chain: chainName,
    failover_used: failoverUsed || forceFailover,
    attempted,
    ...quotaInfo,
  });
});
