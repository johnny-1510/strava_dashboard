// Cloudflare Worker "verical-api" – das einzige Backend von Verical. Kein Konto; gespeichert werden nur verschlüsselte Daten (Sync, Passkey-Schlüssel).
//
//   POST /vision              { image: "<JPEG als Base64>" } -> { items: [{ name, grams, count, unit, confidence }], note }
//   GET  /search?q=skyr       -> Open-Food-Facts-Suche mit CORS (für die Web-Version)
//   GET  /product/<barcode>   -> Open-Food-Facts-Produkt mit CORS
//   GET  /dash-keys           -> veröffentlichte Passkey-Geräteschlüssel fürs Sports Dashboard (KV DASH_KEYS)
//   POST /dash-keys           { id, iv, wrapped } – nur neu anlegen, nie überschreiben, höchstens 20
//   GET  /sync/<id>           -> verschlüsselter Ernährungs-Stand des Dashboards { rev, iv, ct } (KV DASH_KEYS, Schlüssel sync:<id>)
//   PUT  /sync/<id>           { base, iv, ct } – nur wenn base == aktuelle rev (sonst 409 mit aktuellem Stand)
//   GET  /health
//
// Sync: Das Dashboard verschlüsselt Einträge, Lebensmittel, Gewichte und Profil auf dem Gerät (AES-GCM, Schlüssel aus dem
// Dashboard-Geheimnis abgeleitet). Der Worker sieht nur Chiffretext und eine zufällig wirkende ID. Die erste ID, die schreibt,
// wird festgehalten (sync:owner) – andere IDs werden abgewiesen, damit niemand den Speicher vollschreibt.
//
// Wichtig für die Ehrlichkeit der App: Das Bildmodell nennt nur, WAS auf dem Teller liegt und WIE VIEL ungefähr.
// Kalorien und Nährwerte rechnet die App ausschließlich mit den Laborwerten des Bundeslebensmittelschlüssels (BLS).
//
// Einrichten (kostenlos, Workers AI Free: 10.000 Neurons/Tag ≈ 150 Fotos/Tag):
//   Cloudflare Dashboard → Workers & Pages → Create → Worker → Name "verical-api" → Deploy
//   → Edit code: diesen Inhalt einfügen → Deploy
//   → Settings → Bindings → Add → Workers AI → Variable name "AI" → Save
// oder per CLI im Repo: npx wrangler deploy  (nutzt wrangler.toml)

const ALLOWED_ORIGINS = ['https://johnny-1510.github.io'];
const UA = 'Verical/0.1 (kontakt@example.com)';
const FIELDS = 'code,product_name,product_name_de,brands,nutriments,serving_quantity,serving_size,quantity,data_quality_errors_tags,states_tags,image_nutrition_url,image_nutrition_small_url,last_modified_t';
const MODELS = ['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/google/gemma-3-12b-it'];
const MAX_IMAGE_B64 = 2_000_000; // ≈ 1,5 MB JPEG; die App schickt ~150 KB

export const SYSTEM = `Du bist ein Ernährungsassistent. Du siehst ein Foto einer Mahlzeit und listest auf, was darauf zu essen oder zu trinken ist.
Regeln:
- Nenne jede sichtbare Komponente einzeln mit einem einfachen deutschen Lebensmittelnamen, wie er im Bundeslebensmittelschlüssel steht: z. B. "Rührei", "Laugenbrezel", "Vollkornbrot", "Butter", "Gouda", "Kochschinken", "Spaghetti gekocht", "Tomatensauce", "Pommes frites", "Banane", "Cappuccino".
- Getrennt auflisten, was getrennt erkennbar ist (Brot, Aufstrich, Belag), jeweils mit eigener Menge. Schreibe also nicht "Rührei mit Pilzen", sondern "Rührei" und "Champignons gebraten" als zwei Einträge. Nur ein klar erkennbares Gericht darf als Ganzes genannt werden (z. B. "Spaghetti Bolognese", "Pizza Margherita", "Döner").
- Zubereitung nennen, wenn sie sichtbar ist: "gekocht", "gebraten", "roh", "paniert".
- Schätze die essbare Menge in Gramm (Getränke in ml als grams). Nutze Teller (meist 26 cm), Besteck, Hände und Verpackungen als Maßstab.
- Bei zählbaren Dingen zusätzlich count und unit (z. B. 2 "Scheiben", 1 "Stück", 3 "Eier" bei Rührei/Omelett aus erkennbar so vielen Eiern).
- Rate keine unsichtbaren Zutaten (Öl, Zucker, Füllungen), außer sie sind eindeutig zu sehen.
- confidence: "hoch", "mittel" oder "niedrig" – ehrlich.
- Ist kein Essen zu sehen, gib items als leere Liste zurück und erkläre es kurz in note.
Antworte ausschließlich mit JSON in genau diesem Format, ohne weiteren Text:
{"items":[{"name":"Rührei","grams":180,"count":3,"unit":"Eier","confidence":"mittel"}],"note":""}`;

function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(body, status, origin, maxAge) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store', ...cors(origin) },
  });
}

async function getJson(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: ctrl.signal });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !type.includes('json')) return { ok: false, status: r.status };
    return { ok: true, status: r.status, data: await r.json() };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(t);
  }
}

async function offSearch(q) {
  const sal = await getJson(`https://search.openfoodfacts.org/search?q=${encodeURIComponent(q)}&langs=de,en&page_size=25&fields=${FIELDS}`, 9000);
  if (sal.ok && Array.isArray(sal.data.hits)) return { hits: sal.data.hits, source: 'sal' };
  const cgi = await getJson(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=25&lc=de&fields=${FIELDS}`, 12000);
  if (cgi.ok && Array.isArray(cgi.data.products)) return { hits: cgi.data.products, source: 'cgi' };
  return { error: `Open Food Facts nicht erreichbar (Suche ${sal.status || 'Timeout'}, Ausweich ${cgi.status || 'Timeout'})`, status: 502 };
}

/** Antwort des Modells robust in { items, note } verwandeln. Nur Name und Menge werden übernommen – nie Nährwerte. */
export function cleanVision(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s < 0 || e <= s) return { items: [], note: 'Keine auswertbare Antwort' };
    try { obj = JSON.parse(raw.slice(s, e + 1)); } catch { return { items: [], note: 'Keine auswertbare Antwort' }; }
  }
  const list = Array.isArray(obj?.items) ? obj.items : [];
  const items = list.slice(0, 12).map(it => {
    const name = String(it?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const grams = Math.round(Number(it?.grams));
    const count = Number(it?.count);
    return {
      name,
      grams: Number.isFinite(grams) ? grams : 0,
      count: Number.isFinite(count) && count > 0 && count <= 30 ? Math.round(count * 2) / 2 : null,
      unit: it?.unit ? String(it.unit).trim().slice(0, 20) : null,
      confidence: ['hoch', 'mittel', 'niedrig'].includes(it?.confidence) ? it.confidence : 'mittel',
    };
  }).filter(it => it.name && it.grams > 0 && it.grams <= 3000);
  return { items, note: typeof obj?.note === 'string' ? obj.note.slice(0, 200) : '' };
}

async function vision(env, image) {
  const user = [
    { type: 'text', text: 'Was ist auf diesem Foto, und wie viel davon? Nur JSON.' },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
  ];
  let lastErr = '';
  for (const model of MODELS) {
    try {
      const r = await env.AI.run(model, { messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], max_tokens: 700, temperature: 0.1 });
      const out = cleanVision(r?.response ?? r);
      return { ...out, model };
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }
  throw new Error(lastErr || 'Bildmodell nicht erreichbar');
}


// ---- Sports Dashboard: Geräteschlüssel (mit dem Face-ID-Geheimnis eines Passkeys verschlüsselt, ohne Passkey wertlos) ----
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
async function dashKeys(request, env, origin) {
  if (!env.DASH_KEYS) return json({ error: 'KV-Binding DASH_KEYS fehlt' }, 500, origin);
  const list = async () => (await env.DASH_KEYS.get('passkeys', 'json')) || [];
  if (request.method === 'GET') return json({ passkeys: await list() }, 200, origin);
  if (request.method !== 'POST') return json({ error: 'Nur GET/POST' }, 405, origin);
  let b; try { b = await request.json(); } catch { return json({ error: 'Ungültig' }, 400, origin); }
  const ok = b && typeof b.id === 'string' && typeof b.iv === 'string' && typeof b.wrapped === 'string'
    && b.id.length >= 16 && b.id.length <= 400 && b.iv.length === 16 && b.wrapped.length >= 100 && b.wrapped.length <= 600
    && B64.test(b.id) && B64.test(b.iv) && B64.test(b.wrapped);
  if (!ok) return json({ error: 'Ungültig' }, 400, origin);
  const cur = await list();
  const same = cur.find(p => p.id === b.id);
  if (same) { const ident = same.iv === b.iv && same.wrapped === b.wrapped; return json({ ok: ident, exists: true }, ident ? 200 : 409, origin); }
  if (cur.length >= 20) return json({ error: 'Voll' }, 409, origin);
  cur.push({ id: b.id, iv: b.iv, wrapped: b.wrapped, at: Date.now() });
  await env.DASH_KEYS.put('passkeys', JSON.stringify(cur));
  return json({ ok: true }, 201, origin);
}

// ---- Sports Dashboard: Ernährungs-Sync (nur Chiffretext) ----
const SYNC_MAX = 4_000_000;
async function sync(request, env, origin, id) {
  if (!env.DASH_KEYS) return json({ error: 'KV-Binding DASH_KEYS fehlt' }, 500, origin);
  const owner = await env.DASH_KEYS.get('sync:owner');
  if (owner && owner !== id) return json({ error: 'Unbekannt' }, 403, origin);
  const cur = await env.DASH_KEYS.get('sync:' + id, 'json');
  if (request.method === 'GET') return json(cur || { rev: 0, empty: true }, 200, origin);
  if (request.method !== 'PUT') return json({ error: 'Nur GET/PUT' }, 405, origin);
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > SYNC_MAX) return json({ error: 'Zu groß' }, 413, origin);
  let b; try { b = await request.json(); } catch { return json({ error: 'Ungültig' }, 400, origin); }
  const ok = b && Number.isInteger(b.base) && b.base >= 0 && typeof b.iv === 'string' && b.iv.length === 16 && B64.test(b.iv)
    && typeof b.ct === 'string' && b.ct.length >= 20 && b.ct.length <= SYNC_MAX && B64.test(b.ct);
  if (!ok) return json({ error: 'Ungültig' }, 400, origin);
  const rev = cur ? cur.rev : 0;
  if (b.base !== rev) return json({ conflict: true, ...(cur || { rev: 0, empty: true }) }, 409, origin);
  const next = { rev: rev + 1, iv: b.iv, ct: b.ct, z: !!b.z, at: Date.now() };
  if (!owner) await env.DASH_KEYS.put('sync:owner', id);
  await env.DASH_KEYS.put('sync:' + id, JSON.stringify(next));
  return json({ ok: true, rev: next.rev }, 200, origin);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    const url = new URL(request.url);

    if (url.pathname === '/dash-keys') return dashKeys(request, env, origin);
    const sm = url.pathname.match(/^\/sync\/([0-9a-f]{64})$/);
    if (sm) return sync(request, env, origin, sm[1]);

    if (url.pathname === '/vision') {
      if (request.method !== 'POST') return json({ error: 'Nur POST' }, 405, origin);
      if (!env.AI) return json({ error: 'Workers-AI-Binding "AI" fehlt (Settings → Bindings).' }, 500, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Ungültige Anfrage' }, 400, origin); }
      const image = typeof body?.image === 'string' ? body.image.replace(/^data:image\/\w+;base64,/, '') : '';
      if (image.length < 1000) return json({ error: 'Kein Bild' }, 400, origin);
      if (image.length > MAX_IMAGE_B64) return json({ error: 'Bild zu groß' }, 413, origin);
      try {
        return json(await vision(env, image), 200, origin);
      } catch (e) {
        const msg = String(e.message || e);
        const quota = /limit|quota|neuron|429/i.test(msg);
        return json({ error: quota ? 'Tageskontingent der Bilderkennung erreicht. Bitte später noch einmal oder beschreiben.' : 'Bilderkennung gerade nicht verfügbar.' }, quota ? 429 : 502, origin);
      }
    }

    if (request.method !== 'GET') return json({ error: 'Nur GET' }, 405, origin);
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const cached = async () => {
      const hit = await cache.match(cacheKey);
      if (!hit) return null;
      const r = new Response(hit.body, hit);
      Object.entries(cors(origin)).forEach(([k, v]) => r.headers.set(k, v));
      return r;
    };

    if (url.pathname === '/search') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
      if (q.length < 2) return json({ error: 'Suchbegriff zu kurz' }, 400, origin);
      const hit = await cached(); if (hit) return hit;
      const res = await offSearch(q);
      if (res.error) return json({ error: res.error }, res.status, origin);
      const out = json(res, 200, origin, 86400);
      ctx.waitUntil(cache.put(cacheKey, out.clone()));
      return out;
    }

    const m = url.pathname.match(/^\/product\/(\d{6,14})$/);
    if (m) {
      const hit = await cached(); if (hit) return hit;
      const p = await getJson(`https://world.openfoodfacts.org/api/v2/product/${m[1]}.json?fields=${FIELDS}&lc=de`, 12000);
      if (p.status === 404) return json({ status: 0 }, 404, origin, 3600);
      if (!p.ok) return json({ error: `Open Food Facts antwortete mit ${p.status || 'Timeout'}` }, 502, origin);
      const out = json(p.data, 200, origin, 604800);
      ctx.waitUntil(cache.put(cacheKey, out.clone()));
      return out;
    }

    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'verical-api', vision: !!env.AI, sync: true }, 200, origin);
    return json({ error: 'Unbekannter Pfad' }, 404, origin);
  },
};
