// Supabase Edge Function - Webhook S6X Pay
// Deploy: supabase functions deploy s6x-webhook --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const S6X_WEBHOOK_SECRET = Deno.env.get('S6X_WEBHOOK_SECRET') || ''

const META_PIXEL_ID = Deno.env.get('META_PIXEL_ID') || '1466657702229112'
const META_ACCESS_TOKEN = Deno.env.get('META_ACCESS_TOKEN') || ''
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function sha256(value: string) {
  const data = new TextEncoder().encode(value.trim().toLowerCase())
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function sendMetaPurchase(email: string, titles: string[], transactionId: string, amount: number) {
  if (!META_ACCESS_TOKEN) return
  const userData: Record<string, string[]> = {}
  if (email) userData.em = [await sha256(email)]
  await fetch(`https://graph.facebook.com/v21.0/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: [{
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: transactionId || `td-${Date.now()}`,
        action_source: 'website',
        event_source_url: 'https://topdoramas.shop',
        user_data: userData,
        custom_data: {
          currency: 'BRL',
          value: amount || 0,
          content_ids: titles,
          content_type: 'product',
          num_items: titles.length || 1
        }
      }]
    })
  })
}

function verifySignature(payload: string, signature: string | null, secret: string): boolean {
  if (!secret || !signature) return true // se não configurou secret, aceita (só para teste)
  const encoder = new TextEncoder()
  const key = encoder.encode(secret)
  const data = encoder.encode(payload)
  // HMAC-SHA256 simples via Web Crypto
  return crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    .then(async (cryptoKey) => {
      const sig = await crypto.subtle.sign('HMAC', cryptoKey, data)
      const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
      return expected === signature
    })
    .catch(() => false)
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const rawBody = await req.text()
  const signature = req.headers.get('x-webhook-signature') || req.headers.get('X-Webhook-Signature')

  // Validação básica de assinatura (opcional se não tiver secret)
  if (S6X_WEBHOOK_SECRET) {
    const valid = await verifySignature(rawBody, signature, S6X_WEBHOOK_SECRET)
    if (!valid) {
      return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 })
    }
  }

  let payload: any
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 })
  }

  const event = payload.event || payload.type
  const transactionId = payload.transaction_id || payload.data?.transaction_id
  const status = payload.status || payload.data?.status
  const metadata = payload.metadata || payload.data?.metadata || {}
  const orderRef = metadata.dorama_title || metadata.order_reference || payload.order_reference || payload.data?.order_reference || payload.description || payload.data?.description
  const customerEmail = payload.customer?.email || payload.data?.customer?.email

  // Só processa pagamentos confirmados
  const isPaid = event === 'payment.confirmed' || event === 'card.payment.confirmed' || status === 'paid'

  if (!isPaid || !orderRef) {
    return new Response(JSON.stringify({ received: true, processed: false }), { status: 200 })
  }

  // Salva a compra na tabela purchases
  const titles = String(orderRef || '').split(', ').map(t => t.trim()).filter(Boolean)
  const isVipPlan = titles.some(title => title.startsWith('Assinatura VIP'))
  let error = null
  for (const title of titles) {
    const result = await supabase.from('purchases').upsert({
      transaction_id: transactionId ? transactionId + ':' + title : undefined,
      email: customerEmail,
      dorama_title: title,
      status: 'paid',
      raw_payload: payload,
      created_at: new Date().toISOString()
    }, { onConflict: 'transaction_id' })
    if (result.error) error = result.error
  }

  const access = await grantAccess(customerEmail, titles, isVipPlan)

  const amount = Number(payload.amount || payload.data?.amount || payload.value || 0)
  await sendMetaPurchase(customerEmail, titles, String(transactionId || ''), amount)

  return new Response(JSON.stringify({ success: true, dorama: orderRef, access, db_error: error?.message || null }), { status: 200 })
})

async function grantAccess(email: string, titles: string[], isVipPlan: boolean) {
  if (!email) return { ok: false, reason: 'sem email' }
  const listed = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const user = listed.data?.users?.find(u => (u.email || '').toLowerCase() === email.toLowerCase())
  if (!user) return { ok: false, reason: 'conta não encontrada' }

  const meta = { ...(user.user_metadata || {}) }
  const owned = new Set<string>(Array.isArray(meta.owned_titles) ? meta.owned_titles : [])
  titles.forEach(title => owned.add(title))
  meta.owned_titles = Array.from(owned)
  if (isVipPlan) meta.vip = true

  const updated = await supabase.auth.admin.updateUserById(user.id, { user_metadata: meta })
  if (updated.error) return { ok: false, reason: updated.error.message }
  return { ok: true, vip: !!meta.vip, titles: meta.owned_titles }
}
