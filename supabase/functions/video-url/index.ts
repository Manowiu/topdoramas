// Supabase Edge Function - Gera URL assinada do R2 só para quem comprou
// Deploy: supabase functions deploy video-url --no-verify-jwt
// Secrets: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, SUPABASE_URL, SUPABASE_ANON_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20'

const R2_ACCOUNT_ID = Deno.env.get('R2_ACCOUNT_ID')!
const R2_ACCESS_KEY_ID = Deno.env.get('R2_ACCESS_KEY_ID')!
const R2_SECRET_ACCESS_KEY = Deno.env.get('R2_SECRET_ACCESS_KEY')!
const R2_BUCKET = Deno.env.get('R2_BUCKET') || 'doramas'
const SUPABASE_URL = Deno.env.get('PROJECT_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('PROJECT_ANON_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Mapeia título do dorama para o nome do arquivo no R2
const videoKeys: Record<string, string> = {
  'O CEO que Sentiu Minha Gravidez': 'ceo.mp4',
  'Ele Devia Tudo a Mim': 'eledeviatudoamim.mp4',
  'Fui Entregue a um Mafioso à Beira da Morte': 'fuientregueaomafioso.mp4',
  'Você Cancelou o Nosso Casamento, Então Eu Casei com o Seu Rival': 'vocecancelounossocasamento.mp4',
  'Casada com o Bilionário Sem Saber': 'casadacombilionario.mp4',
  'Suas Lágrimas Não Significam Nada Agora': '1118.mp4',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Não autenticado' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } }
    })

    const { data: { user }, error: userError } = await supabase.auth.getUser()
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Sessão inválida' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { title } = await req.json()
    if (!title) {
      return new Response(JSON.stringify({ error: 'Título obrigatório' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Verifica se comprou
    const { data: purchase } = await supabase
      .from('purchases')
      .select('id, dorama_title')
      .eq('email', user.email)
      .eq('status', 'paid')

    const paidOverrides: Record<string, string[]> = {
      'fverlene.souza@hotmail.com': ['O CEO que Sentiu Minha Gravidez'],
      'aurifbarbosa@gmail.com': ['Ele Devia Tudo a Mim'],
      'willgabi24@gmail.com': ['O CEO que Sentiu Minha Gravidez'],
    }
    const isAdmin = user.email === 'admin@topdoramas.com' || user.user_metadata?.role === 'admin'
    const isVipUser = isAdmin || user.user_metadata?.vip === true || user.email === 'gabrieltanajura@gmail.com'
    const hasOverride = (paidOverrides[(user.email || '').toLowerCase()] || []).includes(title)
    const hasVipPurchase = purchase?.some(p => (p.dorama_title || '').startsWith('Assinatura VIP'))
    const hasTitle = purchase?.some(p => {
      const titles = String(p.dorama_title || '').split(', ').map(t => t.trim());
      return titles.includes(title);
    })
    if (!hasTitle && !hasVipPurchase && !isVipUser && !hasOverride) {
      return new Response(JSON.stringify({ error: 'Você não comprou este dorama' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const key = videoKeys[title]
    if (!key) {
      return new Response(JSON.stringify({ error: 'Vídeo não encontrado no R2' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Gera URL assinada (válida por 2 horas)
    const r2 = new AwsClient({
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    })

    const url = new URL(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${key}`)
    url.searchParams.set('X-Amz-Expires', '7200')

    const signed = await r2.sign(new Request(url, { method: 'GET' }), {
      aws: { signQuery: true },
    })

    return new Response(JSON.stringify({ url: signed.url }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
