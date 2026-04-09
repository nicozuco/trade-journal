import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type TradovateEnvironment = "demo" | "live";

type TradovateConnectRequest = {
  environment?: string;
  username?: string;
  password?: string;
};

type JsonBody = Record<string, unknown>;

type TradovateConnectionRow = {
  id: string;
  environment: TradovateEnvironment;
  status: string;
  tradovate_username: string | null;
  last_connected_at: string | null;
  updated_at: string;
};

const TRADOVATE_BASE_URL_DEMO = Deno.env.get("TRADOVATE_BASE_URL_DEMO") ?? "";
const TRADOVATE_BASE_URL_LIVE = Deno.env.get("TRADOVATE_BASE_URL_LIVE") ?? "";
const TRADOVATE_ENCRYPTION_KEY = Deno.env.get("TRADOVATE_ENCRYPTION_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function jsonResponse(body: JsonBody, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders,
  });
}

function getBearerToken(req: Request): string | null {
  const authorization = req.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function isTradovateEnvironment(value: string): value is TradovateEnvironment {
  return value === "demo" || value === "live";
}

function getStringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getSupabaseAdminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function encodeBase64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function encryptPasswordScaffold(password: string): string {
  // Temporary scaffold only. Replace with real encryption before production use.
  const prefix = TRADOVATE_ENCRYPTION_KEY || "missing-encryption-key";
  return encodeBase64Utf8(`${prefix}:${password}`);
}

async function getAuthenticatedUser(req: Request) {
  const token = getBearerToken(req);
  if (!token) {
    return { user: null, error: "Missing Authorization Bearer token." } as const;
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return { user: null, error: "Missing Supabase server environment variables." } as const;
  }

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    return { user: null, error: error?.message ?? "Invalid or expired token." } as const;
  }

  return { user, error: null } as const;
}

async function saveTradovateConnection(params: {
  userId: string;
  environment: TradovateEnvironment;
  username: string;
  password: string;
}) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return { connection: null, error: "Missing Supabase server environment variables." } as const;
  }

  const encryptedPassword = encryptPasswordScaffold(params.password);
  const now = new Date().toISOString();

  const { data: existingConnection, error: existingError } = await supabase
    .from("tradovate_connections")
    .select("id")
    .eq("user_id", params.userId)
    .eq("environment", params.environment)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (existingError) {
    return { connection: null, error: existingError.message } as const;
  }

  if (existingConnection) {
    const { data, error } = await supabase
      .from("tradovate_connections")
      .update({
        tradovate_username: params.username,
        encrypted_password: encryptedPassword,
        status: "connected",
        last_error: null,
        last_connected_at: now,
      })
      .eq("id", existingConnection.id)
      .select("id, environment, status, tradovate_username, last_connected_at, updated_at")
      .single<TradovateConnectionRow>();

    if (error) {
      return { connection: null, error: error.message } as const;
    }

    return { connection: data, error: null } as const;
  }

  const { data, error } = await supabase
    .from("tradovate_connections")
    .insert({
      user_id: params.userId,
      environment: params.environment,
      auth_mode: "api_key_credentials",
      tradovate_username: params.username,
      encrypted_password: encryptedPassword,
      status: "connected",
      has_live: false,
      last_error: null,
      last_connected_at: now,
    })
    .select("id, environment, status, tradovate_username, last_connected_at, updated_at")
    .single<TradovateConnectionRow>();

  if (error) {
    return { connection: null, error: error.message } as const;
  }

  return { connection: data, error: null } as const;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed." }, 405);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ ok: false, error: "Missing Supabase server environment variables." }, 500);
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body." }, 400);
  }

  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return jsonResponse({ ok: false, error: "Body must be a JSON object." }, 400);
  }

  const body = rawBody as TradovateConnectRequest;
  const environment = getStringField(body.environment);
  const username = getStringField(body.username);
  const password = getStringField(body.password);

  if (!environment) {
    return jsonResponse({ ok: false, error: "environment is required." }, 400);
  }

  if (!isTradovateEnvironment(environment)) {
    return jsonResponse({ ok: false, error: "environment must be 'demo' or 'live'." }, 400);
  }

  if (!username) {
    return jsonResponse({ ok: false, error: "username is required." }, 400);
  }

  if (!password) {
    return jsonResponse({ ok: false, error: "password is required." }, 400);
  }

  const { user, error } = await getAuthenticatedUser(req);
  if (!user) {
    return jsonResponse({ ok: false, error: error ?? "Unauthorized." }, 401);
  }

  const { connection, error: saveError } = await saveTradovateConnection({
    userId: user.id,
    environment,
    username,
    password,
  });

  if (!connection || saveError) {
    return jsonResponse(
      {
        ok: false,
        error: saveError ?? "Failed to save Tradovate connection.",
      },
      500,
    );
  }

  return jsonResponse({
    ok: true,
    message: "tradovate connection saved",
    userId: user.id,
    environment,
    connection: {
      id: connection.id,
      environment: connection.environment,
      status: connection.status,
      tradovate_username: connection.tradovate_username,
      last_connected_at: connection.last_connected_at,
      updated_at: connection.updated_at,
    },
  });
});
