import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type JsonBody = Record<string, unknown>;

type TradovateConnectionRow = {
  id: string;
  environment: string;
  status: string;
  tradovate_username: string | null;
  access_token_expires_at: string | null;
  last_connected_at: string | null;
  updated_at: string;
};

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

async function getLatestTradovateConnection(userId: string) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return { connection: null, error: "Missing Supabase server environment variables." } as const;
  }

  const { data, error } = await supabase
    .from("tradovate_connections")
    .select(
      "id, environment, status, tradovate_username, access_token_expires_at, last_connected_at, updated_at",
    )
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle<TradovateConnectionRow>();

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

  const { user, error } = await getAuthenticatedUser(req);
  if (!user) {
    return jsonResponse({ ok: false, error: error ?? "Unauthorized." }, 401);
  }

  const { connection, error: connectionError } = await getLatestTradovateConnection(user.id);
  if (connectionError) {
    return jsonResponse({ ok: false, error: connectionError }, 500);
  }

  return jsonResponse({
    ok: true,
    message: "tradovate-accounts scaffold ready",
    userId: user.id,
    hasConnection: Boolean(connection),
    connection: connection
      ? {
          id: connection.id,
          environment: connection.environment,
          status: connection.status,
          tradovate_username: connection.tradovate_username,
          access_token_expires_at: connection.access_token_expires_at,
          last_connected_at: connection.last_connected_at,
          updated_at: connection.updated_at,
        }
      : null,
  });
});
