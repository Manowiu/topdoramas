import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const S6X_CLIENT_ID = Deno.env.get('S6X_CLIENT_ID')!
const S6X_CLIENT_SECRET = Deno.env.get('S6X_CLIENT_SECRET')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const PAID_STATUSES = ['paid', 'approved', 'confirmed', 'completed', 'succeeded', 'success']

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  }

  try {
    const body = await req.json()
    if (body.action === 'status') {
      return await checkStatus(body)
    }

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
    const payment = data.data || data
    const transactionId = payment?.transaction_id || payment?.transactionId || payment?.id || payment?.payment_id || data.transaction_id || data.id
    if (payment && transactionId && !payment.transaction_id) payment.transaction_id = transactionId
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

async function checkStatus(body: { transaction_id?: string, email?: string, user_id?: string, title?: string }) {
  const transactionId = body.transaction_id
  if (!transactionId) {
    return json({ success: false, error: 'Transação obrigatória' }, 400)
  }

  const res = await fetch(`https://s6xpay.com/api/v1/payments/${encodeURIComponent(transactionId)}`, {
    headers: {
      'X-Client-Id': S6X_CLIENT_ID,
      'X-Client-Secret': S6X_CLIENT_SECRET,
    },
  })
  const data = await res.json()
  const status = String(
    data.status || data.data?.status || data.payment?.status || data.data?.payment?.status || ''
  ).toLowerCase()
  const paid = ['paid', 'approved', 'confirmed', 'completed', 'succeeded', 'success', 'pago', 'received', 'settled'].includes(status)
    || status.includes('paid')
    || status.includes('confirm')
    || status.includes('approv')
    || data.paid === true
    || data.data?.paid === true
  if (paid && (body.email || body.user_id) && body.title) {
    await grantAccess(body.email, body.user_id, String(body.title).split(', ').map(t => t.trim()).filter(Boolean))
  }
  return json({ success: true, paid, status, data })
}

async function grantAccess(email: string | undefined, userId: string | undefined, titles: string[]) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  let user = null
  if (userId) {
    const byId = await supabase.auth.admin.getUserById(userId)
    user = byId.data?.user || null
  }
  if (!user && email) {
    const listed = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 })
    user = listed.data?.users?.find(u => (u.email || '').toLowerCase() === email.toLowerCase()) || null
  }
  if (!user) return
  const meta = { ...(user.user_metadata || {}) }
  const owned = new Set<string>(Array.isArray(meta.owned_titles) ? meta.owned_titles : [])
  titles.forEach(title => owned.add(title))
  meta.owned_titles = Array.from(owned)
  if (titles.some(title => title.startsWith('Assinatura VIP'))) {
    meta.vip = true
    meta.vip_plan = title
    const days = title.includes('Vital') ? null : title.includes('Semestral') ? 180 : title.includes('Semanal') ? 7 : 30
    meta.vip_until = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null
  }
  await supabase.auth.admin.updateUserById(user.id, { user_metadata: meta })
  for (const title of titles) {
    await supabase.from('purchases').upsert({
      transaction_id: `status:${user.id}:${title}`,
      email: user.email || email,
      dorama_title: title,
      status: 'paid',
      created_at: new Date().toISOString()
    }, { onConflict: 'transaction_id' })
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}