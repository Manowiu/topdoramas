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

const META_PIXEL_ID = Deno.env.get('META_PIXEL_ID') || '1466657702229112'
const META_ACCESS_TOKEN = Deno.env.get('META_ACCESS_TOKEN') || ''

async function sha256(value: string) {
  const data = new TextEncoder().encode(value.trim().toLowerCase())
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function sendMetaPurchase(email: string | undefined, title: string, transactionId: string, value: number, tracking: any = {}) {
  if (!META_ACCESS_TOKEN) return
  const userData: Record<string, string | string[]> = {}
  if (email) userData.em = [await sha256(email)]
  if (tracking.fbp) userData.fbp = tracking.fbp
  if (tracking.fbc) userData.fbc = tracking.fbc
  await fetch(`https://graph.facebook.com/v21.0/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: [{
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: tracking.event_id || ('purchase-' + transactionId),
        action_source: 'website',
        event_source_url: tracking.event_source_url || 'https://topdoramas.shop',
        user_data: userData,
        custom_data: {
          currency: 'BRL',
          value: Number(value || 0),
          content_ids: [title],
          content_name: title,
          content_type: 'product',
          num_items: 1
        }
      }]
    })
  })
}

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

async function checkStatus(body: { transaction_id?: string, email?: string, user_id?: string, title?: string, value?: number, tracking?: any }) {
  const transactionId = body.transaction_id
  if (!transactionId) {
    return json({ success: false, error: 'Transação obrigatória' }, 400)
  }

  const urls = [
    `https://s6xpay.com/api/v1/payments/${encodeURIComponent(transactionId)}`,
    `https://s6xpay.com/api/v1/transactions/${encodeURIComponent(transactionId)}`,
    `https://s6xpay.com/api/v1/payments?transaction_id=${encodeURIComponent(transactionId)}`
  ]
  let data: any = null
  for (const url of urls) {
    const res = await fetch(url, {
      headers: {
        'X-Client-Id': S6X_CLIENT_ID,
        'X-Client-Secret': S6X_CLIENT_SECRET,
      },
    })
    if (!res.ok) continue
    data = await res.json()
    if (data) break
  }
  data = data || {}
  const status = String(
    data.status || data.data?.status || data.payment?.status || data.data?.payment?.status || ''
  ).toLowerCase()
  const paid = ['paid', 'approved', 'confirmed', 'completed', 'succeeded', 'success', 'pago', 'received', 'settled'].includes(status)
    || status.includes('paid')
    || status.includes('confirm')
    || status.includes('approv')
    || data.paid === true
    || data.data?.paid === true
    || !!data.paid_at
    || !!data.data?.paid_at
  if (paid && body.title) {
    const titles = String(body.title).includes(' || ') ? String(body.title).split(' || ') : [String(body.title)]
    const cleanTitles = titles.map(t => t.trim()).filter(Boolean)
    await grantAccess(body.email, body.user_id, cleanTitles)
    await sendMetaPurchase(body.email, body.title, transactionId, Number(body.value || 0), body.tracking || {})
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