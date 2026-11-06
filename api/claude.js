// Puente entre la app y la API de Claude. La clave vive solo aquí, en el servidor.
// Variables de entorno en Vercel:
//   ANTHROPIC_API_KEY  tu clave de https://console.anthropic.com (obligatoria)
//   APP_CODE           código de acceso que la app pide una vez (obligatorio; evita que otros gasten tu saldo)

const MODELS = { quick: "claude-haiku-5-5", default: "claude-sonnet-5-5", complex: "claude-sonnet-5-5" };
const MAX_IMAGES = 3;
const MAX_IMAGE_B64 = 1_500_000;      // ~1.1 MB por imagen
const MAX_TEXT = 200_000;             // caracteres de texto en total
const WINDOW_MS = 10 * 60 * 1000, MAX_PER_WINDOW = 40;
const hits = new Map();               // límite simple por IP (por instancia)

function limited(ip){
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  list.push(now); hits.set(ip, list);
  return list.length > MAX_PER_WINDOW;
}

module.exports = async function handler(req, res){
  res.setHeader("Cache-Control", "no-store");
  if(req.method !== "POST") return res.status(405).json({ code:"invalid_request", message:"Usa POST." });
  if(!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ code:"not_configured", message:"Falta ANTHROPIC_API_KEY en Vercel." });
  if(!process.env.APP_CODE) return res.status(503).json({ code:"not_configured", message:"Falta APP_CODE en Vercel." });
  if(req.headers["x-app-code"] !== process.env.APP_CODE) return res.status(401).json({ code:"not_granted", message:"Código de acceso incorrecto." });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "local";
  if(limited(ip)) return res.status(429).json({ code:"rate_limited", message:"Demasiadas consultas. Espera unos minutos." });

  let body = req.body;
  try{ if(typeof body === "string") body = JSON.parse(body); }catch{ body = null; }
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if(!messages || !messages.length || messages[messages.length-1].role !== "user")
    return res.status(400).json({ code:"invalid_request", message:"Mensajes inválidos." });
  const textLen = messages.reduce((a,m)=>a + String(m.content||"").length, 0);
  if(textLen > MAX_TEXT) return res.status(413).json({ code:"prompt_too_large", message:"El texto es demasiado largo." });

  const images = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES)
    .filter(im => im && /^image\/(jpeg|png|webp|gif)$/.test(im.media_type) && typeof im.data === "string" && im.data.length <= MAX_IMAGE_B64);

  const msgs = messages.map((m, i) => {
    const content = [{ type:"text", text:String(m.content||"") }];
    if(i === messages.length-1 && images.length)
      content.unshift(...images.map(im => ({ type:"image", source:{ type:"base64", media_type:im.media_type, data:im.data } })));
    return { role: m.role === "assistant" ? "assistant" : "user", content };
  });

  const system = "Eres el asistente de cocina y nutrición de la app Recetok. Respondes en español." +
    (body.json ? " Tu respuesta será leída por un programa: responde SOLO con el JSON pedido, sin texto antes ni después y sin bloques de código." : "");

  try{
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{ "content-type":"application/json", "x-api-key":process.env.ANTHROPIC_API_KEY, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model: MODELS[body.tier] || MODELS.default, max_tokens: body.tier === "quick" ? 1500 : 8000, system, messages: msgs }),
    });
    const d = await r.json().catch(() => ({}));
    if(!r.ok){
      const map = { 400:"invalid_request", 401:"not_configured", 403:"not_configured", 413:"prompt_too_large", 429:"rate_limited" };
      const code = map[r.status] || "upstream_error";
      const msg = r.status === 401 || r.status === 403 ? "La clave de Anthropic no es válida." : (d?.error?.message || "Error del servicio de IA.");
      return res.status(r.status === 401 || r.status === 403 ? 503 : r.status).json({ code, message: msg });
    }
    const text = (d.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    if(!text.trim()) return res.status(502).json({ code:"empty_completion", message:"La IA no respondió." });
    return res.status(200).json({ text, truncated: d.stop_reason === "max_tokens" });
  }catch(e){
    return res.status(502).json({ code:"upstream_error", message:"No se pudo contactar a la IA." });
  }
};
