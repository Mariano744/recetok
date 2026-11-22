/* Recetok como app instalable: conecta la IA al servidor propio, guarda archivos y ofrece instalar. */
(function(){
  const CODE_KEY = "recetok_code";
  const getCode = () => { try{ return localStorage.getItem(CODE_KEY) || ""; }catch{ return ""; } };
  const setCode = v => { try{ v ? localStorage.setItem(CODE_KEY, v) : localStorage.removeItem(CODE_KEY); }catch{} };

  /* --- clave de Claude: se pega una vez en la app, se guarda solo en este dispositivo y las consultas van directo a Claude --- */
  const KEY_KEY = "recetok_claude_key";
  const getKey = () => { try{ return (localStorage.getItem(KEY_KEY) || "").trim(); }catch{ return ""; } };
  const setKey = v => { try{ v ? localStorage.setItem(KEY_KEY, v.trim()) : localStorage.removeItem(KEY_KEY); }catch{} };
  function askKey(wrong){
    return new Promise(resolve => {
      const box = document.createElement("div");
      box.className = "modal"; box.setAttribute("role","dialog"); box.setAttribute("aria-modal","true");
      const cur = getKey();
      box.innerHTML = `<form class="modal-in codebox">
        <div class="modal-head"><h3>Tu clave de Claude</h3></div>
        <p class="muted">${wrong ? "<b style='color:var(--bad)'>Esa clave no funcionó.</b> " : ""}Pega tu clave de API de Anthropic (empieza con <b>sk-ant-</b>). Se guarda solo en este dispositivo y las consultas van directo a Claude. Créala en <b>console.anthropic.com</b> → <i>API Keys</i>.</p>
        <input type="password" autocomplete="off" placeholder="sk-ant-…" aria-label="Clave de Claude" value="${cur ? "•".repeat(12) : ""}" style="font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)">
        <div class="row">${cur ? `<button type="button" class="btn" data-del>Quitar clave</button>` : ""}<button type="button" class="btn" data-x>Cancelar</button><button class="btn primary">Guardar</button></div>
      </form>`;
      document.body.appendChild(box);
      const inp = box.querySelector("input"); inp.focus(); inp.select();
      const done = v => { box.remove(); resolve(v); };
      box.querySelector("[data-x]").onclick = () => done("");
      const del = box.querySelector("[data-del]"); if(del) del.onclick = () => { setKey(""); done(""); };
      box.querySelector("form").onsubmit = e => { e.preventDefault(); const v = inp.value.trim(); if(/^•+$/.test(v)) return done(cur); if(v.length > 20){ setKey(v); done(v); } };
    });
  }

  /* --- ventana para el código de acceso (solo si usas el servidor de Vercel) --- */
  function askCode(wrong){
    return new Promise(resolve => {
      const box = document.createElement("div");
      box.className = "modal"; box.setAttribute("role","dialog"); box.setAttribute("aria-modal","true");
      box.innerHTML = `<form class="modal-in codebox">
        <div class="modal-head"><h3>Código de acceso</h3></div>
        <p class="muted">${wrong ? "<b style='color:var(--bad)'>Ese código no funcionó.</b> " : ""}Escribe el código de tu app para usar la IA. Solo se pide una vez en este dispositivo.</p>
        <input type="password" autocomplete="current-password" placeholder="Código" aria-label="Código de acceso" required style="font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)">
        <div class="row"><button type="button" class="btn" data-x>Cancelar</button><button class="btn primary">Continuar</button></div>
      </form>`;
      document.body.appendChild(box);
      const inp = box.querySelector("input"); inp.focus();
      const done = v => { box.remove(); resolve(v); };
      box.querySelector("[data-x]").onclick = () => done("");
      box.querySelector("form").onsubmit = e => { e.preventDefault(); const v = inp.value.trim(); if(v){ setCode(v); done(v); } };
    });
  }

  /* --- imágenes: se reducen antes de enviarlas --- */
  async function toB64(blob){
    try{
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width*scale); c.height = Math.round(bmp.height*scale);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      const url = c.toDataURL("image/jpeg", .82);
      return { media_type:"image/jpeg", data:url.split(",")[1] };
    }catch{ throw { code:"image_rejected", message:"No se pudo leer la imagen." }; }
  }

  function parseJSON(text){
    const t = String(text).trim();
    try{ return JSON.parse(t); }catch{}
    const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if(f){ try{ return JSON.parse(f[1]); }catch{} }
    const a = Math.min(...["{","["].map(ch => { const i = t.indexOf(ch); return i<0 ? Infinity : i; }));
    const b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if(a !== Infinity && b > a){ try{ return JSON.parse(t.slice(a, b+1)); }catch{} }
    throw { code:"invalid_json", message:"Respuesta incompleta.", text:t };
  }

  const MODELS = { quick:"claude-haiku-5-5", default:"claude-sonnet-5-5", complex:"claude-sonnet-5-5" };
  const SYSTEM = "Eres el asistente de cocina y nutrición de la app Recetok. Respondes en español.";
  async function direct(messages, imgs, opts, json, key, retried){
    const msgs = messages.map((m, i) => {
      const content = [{ type:"text", text:String(m.content || "") }];
      if(i === messages.length - 1 && imgs.length) content.unshift(...imgs.map(im => ({ type:"image", source:{ type:"base64", media_type:im.media_type, data:im.data } })));
      return { role: m.role === "assistant" ? "assistant" : "user", content };
    });
    const tier = opts.modelTier || "default";
    let r;
    try{
      r = await fetch("https://api.anthropic.com/v1/messages", { method:"POST", signal:opts.signal,
        headers:{ "content-type":"application/json", "x-api-key":key, "anthropic-version":"2023-06-01", "anthropic-dangerous-direct-browser-access":"true" },
        body: JSON.stringify({ model: MODELS[tier] || MODELS.default, max_tokens: tier === "quick" ? 3000 : 8000,
          system: SYSTEM + (json ? " Tu respuesta será leída por un programa: responde SOLO con el JSON pedido, sin texto antes ni después y sin bloques de código." : ""), messages: msgs }) });
    }catch(e){
      if(opts.signal?.aborted) throw { code:"cancelled" };
      throw { code: navigator.onLine === false ? "offline" : "upstream_error", message:"Sin conexión." };
    }
    const d = await r.json().catch(() => ({}));
    if(r.status === 401 || r.status === 403){ setKey(""); const k = await askKey(true); if(!k || retried) throw { code:"not_granted", message:"" }; return direct(messages, imgs, opts, json, k, true); }
    if(!r.ok){
      const credit = r.status === 400 && /credit|balance/i.test(d?.error?.message || "");
      throw { code: r.status === 429 ? "rate_limited" : r.status === 529 ? "busy" : r.status === 413 ? "prompt_too_large" : "upstream_error",
        message: credit ? "Se acabó el saldo de tu cuenta de Anthropic." : (d?.error?.message || "") };
    }
    const text = (d.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    if(!text.trim()) throw { code:"empty_completion", message:"La IA no respondió." };
    try{ opts.onText?.({ text, delta:text }); }catch{}
    try{ opts.onMeta?.({ fallback:"" }); }catch{}
    return json ? parseJSON(text) : { text, truncated: d.stop_reason === "max_tokens", modelTierApplied:tier };
  }

  async function call(input, opts = {}, json = false, retried = false){
    if(opts.signal?.aborted) throw { code:"cancelled" };
    const messages = typeof input === "string" ? [{ role:"user", content:input }] : input;
    let imgs = [];
    if(opts.images){ const arr = opts.images instanceof Blob ? [opts.images] : [...opts.images]; imgs = await Promise.all(arr.slice(0,3).map(toB64)); }
    let key = getKey(), code = getCode();
    if(key || !code){                                   // lo normal: tu clave de Claude, directo (como el servidor de Vercel ya no hace falta)
      if(!key){ key = await askKey(false); if(!key) throw { code:"not_granted", message:"" }; }
      return direct(messages, imgs, opts, json, key, false);
    }
    let r;
    try{
      r = await fetch("/api/claude", { method:"POST", signal:opts.signal,
        headers:{ "content-type":"application/json", "x-app-code":code },
        body: JSON.stringify({ messages, images:imgs, tier:opts.modelTier || "default", json, videoUrl:opts.videoUrl }) });
    }catch(e){
      if(opts.signal?.aborted) throw { code:"cancelled" };
      throw { code: navigator.onLine === false ? "offline" : "upstream_error", message:"Sin conexión." };
    }
    const d = await r.json().catch(() => ({ code: r.status === 504 ? "timeout" : "upstream_error", message: "HTTP " + r.status }));
    if(r.status === 401){ setCode(""); if(!retried) return call(input, opts, json, true); throw { code:"not_granted", message:d.message }; }
    if(!r.ok) throw { code: d.code || "upstream_error", message: d.message || "" };
    try{ opts.onText?.({ text:d.text, delta:d.text }); }catch{}
    try{ opts.onMeta?.({ fallback:d.fallback || "" }); }catch{}
    return json ? parseJSON(d.text) : { text:d.text, truncated:!!d.truncated, modelTierApplied:opts.modelTier || "default" };
  }
  const sample = (input, opts) => call(input, opts, false);
  sample.json = (input, opts) => call(input, opts, true);
  sample.limits = async () => ({ maxPromptBytes:262144, images:{ maxCount:3, maxInputBytes:20e6, mediaTypes:["image/jpeg","image/png","image/webp","image/gif"] } });

  /* --- guardar archivos: compartir en el celular o descargar --- */
  const downloads = {
    async save({ filename, data }){
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.json$/.test(filename) ? "application/json" : "application/octet-stream" });
      const file = new File([blob], filename, { type: blob.type });
      if(navigator.canShare?.({ files:[file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)){
        try{ await navigator.share({ files:[file], title:filename }); return; }
        catch(e){ if(e?.name === "AbortError") throw { code:"declined" }; }
      }
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
  };

  window.claude = { use: async name => name === "sample" ? sample : name === "downloads" ? downloads : null };
  Object.defineProperty(window, "RECETOK_APP", { get: () => !getKey() && !!getCode() });   // el servidor puede ver videos; Claude directo no
  window.RECETOK_KEY = { change: () => askKey(false) };

  /* --- instalar y trabajar sin conexión --- */
  if("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(()=>{}));
  let deferred = null;
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  function installBtn(){
    if(standalone || document.getElementById("installBtn")) return null;
    const tabs = document.querySelector(".appbar-in"); if(!tabs) return null;
    const b = document.createElement("button"); b.id = "installBtn"; b.className = "btn small primary installbtn"; b.textContent = "Instalar";
    tabs.insertBefore(b, tabs.querySelector(".tabs")); return b;
  }
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault(); deferred = e;
    const b = installBtn(); if(b) b.onclick = async () => { deferred.prompt(); await deferred.userChoice.catch(()=>{}); deferred = null; b.remove(); };
  });
  window.addEventListener("DOMContentLoaded", () => {
    if(!standalone && /iPhone|iPad/i.test(navigator.userAgent)){
      const b = installBtn(); if(b) b.onclick = () => {
        const box = document.createElement("div"); box.className = "modal";
        box.innerHTML = `<div class="modal-in"><div class="modal-head"><h3>Instalar en iPhone</h3><button class="btn small">Listo</button></div>
          <p class="muted">1. Abre esta página en <b>Safari</b>.<br>2. Toca <b>Compartir</b> (el cuadrado con flecha).<br>3. Elige <b>Agregar a pantalla de inicio</b>.</p></div>`;
        document.body.appendChild(box); box.querySelector("button").onclick = () => box.remove();
      };
    }
  });
  window.addEventListener("appinstalled", () => document.getElementById("installBtn")?.remove());
})();
