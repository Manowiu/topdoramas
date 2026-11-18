// Supabase Edge Function - Criar Pagamento S6X (seguro)
// Deploy: supabase functions deploy criar-pagamento --no-verify-jwt
// Secrets necessários: S6X_CLIENT_ID e S6X_CLIENT_SECRET

const S6X_CLIENT_ID = Deno.env.get('S6X_CLIENT_ID')!
const S6X_CLIENT_SECRET = Deno.env.get('S6X_CLIENT_SECRET')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  }

  try {
    const body = await req.json()

    const res = await fetch('https://s6xpay.com/api/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': S6X_CLIENT_ID,
        'X-Client-Secret': S6X_CLIENT_SECRET,
      },
      body: JSON.stringify(body),
    })

    const data = await res.json()

    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
