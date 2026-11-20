const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 7000;
const PAGE_SIZE = 100;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 دقيقة كاش لتقليل الضغط على سيرفر الـ IPTV
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// نظام كاش بسيط في الذاكرة
const cache = new Map();
function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}
function setCache(key, data, ttl = CACHE_TTL_MS) {
  cache.set(key, { data, expiry: Date.now() + ttl });
}

// فك تشفير إعدادات المستخدم من الرابط
function decodeConfig(configStr) {
  try {
    const json = Buffer.from(configStr, 'base64url').toString('utf8');
    const cfg = JSON.parse(json);
    if (cfg.host) cfg.host = cfg.host.trim().replace(/\/+$/, '');
    return cfg;
  } catch {
    return null;
  }
}

// =======================
// دوال جلب البيانات (Xtream)
// =======================
async function xtreamApi(cfg, action, extraParams = {}) {
  const cacheKey = `xt:${cfg.host}:${cfg.user}:${action}:${JSON.stringify(extraParams)}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const url = `${cfg.host}/player_api.php`;
  const response = await axios.get(url, {
    params: {
      username: cfg.user,
      password: cfg.pass,
      action,
      ...extraParams
    },
    headers: { 'User-Agent': USER_AGENT },
    timeout: 25000
  });

  const data = response.data;
  setCache(cacheKey, data);
  return data;
}

async function getXtreamCategoryMap(cfg, action) {
  try {
    const cats = await xtreamApi(cfg, action);
    if (!Array.isArray(cats)) return { map: {}, names: [] };
    const map = {};
    const names = [];
    for (const c of cats) {
      map[String(c.category_id)] = c.category_name;
      if (c.category_name && !names.includes(c.category_name)) {
        names.push(c.category_name);
      }
    }
    return { map, names };
  } catch {
    return { map: {}, names: [] };
  }
}

// =======================
// دوال قراءة وتحليل (M3U)
// =======================
async function getM3UItems(m3uUrl) {
  const cacheKey = `m3u:${m3uUrl}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const response = await axios.get(m3uUrl, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 30000,
    responseType: 'text'
  });

  const lines = response.data.split(/\r?\n/);
  const items = [];
  const groupsSet = new Set();
  let currentMeta = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      const commaIdx = line.lastIndexOf(',');
      const name = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : 'Unknown Channel';
      const group = groupMatch && groupMatch[1] ? groupMatch[1].trim() : 'General';
      groupsSet.add(group);

      currentMeta = {
        name,
        poster: logoMatch ? logoMatch[1] : '',
        group
      };
    } else if (!line.startsWith('#') && currentMeta) {
      items.push({
        id: `m3u_ch_${items.length}`,
        name: currentMeta.name,
        poster: currentMeta.poster,
        group: currentMeta.group,
        url: line
      });
      currentMeta = null;
    }
  }

  const result = { items, groups: Array.from(groupsSet) };
  setCache(cacheKey, result);
  return result;
}

// =======================
// صفحة الإعدادات (/configure)
// =======================
const CONFIG_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>إعداد إضافة Stremio IPTV</title>
  <style>
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
    body { background: #0f111a; color: #e6e8f0; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: #1a1d2d; padding: 28px; border-radius: 16px; width: 100%; max-width: 480px; box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
    h1 { margin: 0 0 8px; font-size: 22px; color: #a78bfa; }
    p.sub { margin: 0 0 20px; font-size: 14px; color: #9ca3af; }
    .tabs { display: flex; gap: 8px; margin-bottom: 20px; }
    .tab { flex: 1; padding: 10px; border: 1px solid #2e334d; background: #131624; color: #9ca3af; border-radius: 10px; cursor: pointer; font-weight: 600; }
    .tab.active { background: #7c3aed; color: #fff; border-color: #7c3aed; }
    .field { margin-bottom: 14px; }
    label { display: block; font-size: 13px; margin-bottom: 6px; color: #cbd5e1; }
    input { width: 100%; padding: 11px 12px; border-radius: 8px; border: 1px solid #333952; background: #0f111a; color: #fff; font-size: 14px; direction: ltr; }
    input:focus { outline: none; border-color: #8b5cf6; }
    .hidden { display: none; }
    .actions { display: flex; flex-direction: column; gap: 10px; margin-top: 20px; }
    button.primary { background: #7c3aed; color: #fff; border: none; padding: 12px; border-radius: 10px; font-size: 15px; font-weight: 700; cursor: pointer; }
    button.secondary { background: #262b40; color: #e2e8f0; border: 1px solid #3b4261; padding: 11px; border-radius: 10px; font-size: 14px; cursor: pointer; }
    .msg { margin-top: 12px; font-size: 13px; color: #34d399; word-break: break-all; direction: ltr; text-align: left; }
  </style>
</head>
<body>
  <div class="card">
    <h1>ربط IPTV مع Stremio</h1>
    <p class="sub">أدخل بيانات اشتراكك لتوليد رابط الإضافة الخاص بك.</p>

    <div class="tabs">
      <button class="tab active" id="tab-xtream" onclick="switchMode('xtream')">Xtream Codes</button>
      <button class="tab" id="tab-m3u" onclick="switchMode('m3u')">رابط M3U</button>
    </div>

    <div id="xtream-fields">
      <div class="field">
        <label>رابط السيرفر (Host URL)</label>
        <input id="host" placeholder="http://server.example.com:8080" />
      </div>
      <div class="field">
        <label>اسم المستخدم (Username)</label>
        <input id="user" placeholder="username" />
      </div>
      <div class="field">
        <label>كلمة المرور (Password)</label>
        <input id="pass" type="password" placeholder="password" />
      </div>
    </div>

    <div id="m3u-fields" class="hidden">
      <div class="field">
        <label>رابط قائمة التشغيل (M3U URL)</label>
        <input id="m3uUrl" placeholder="http://server.example.com/get.php?..." />
      </div>
    </div>

    <div class="actions">
      <button class="primary" onclick="installStremio()">تثبيت مباشر في Stremio</button>
      <button class="secondary" onclick="copyManifest()">نسخ رابط Manifest يدوياً</button>
    </div>
    <div id="output" class="msg"></div>
  </div>

  <script>
    let mode = 'xtream';
    function switchMode(m) {
      mode = m;
      document.getElementById('tab-xtream').classList.toggle('active', m === 'xtream');
      document.getElementById('tab-m3u').classList.toggle('active', m === 'm3u');
      document.getElementById('xtream-fields').classList.toggle('hidden', m !== 'xtream');
      document.getElementById('m3u-fields').classList.toggle('hidden', m !== 'm3u');
    }

    function buildManifestUrl() {
      let payload;
      if (mode === 'xtream') {
        const host = document.getElementById('host').value.trim();
        const user = document.getElementById('user').value.trim();
        const pass = document.getElementById('pass').value.trim();
        if (!host || !user || !pass) { alert('يرجى إدخال جميع بيانات Xtream'); return null; }
        payload = { mode: 'xtream', host, user, pass };
      } else {
        const m3uUrl = document.getElementById('m3uUrl').value.trim();
        if (!m3uUrl) { alert('يرجى إدخال رابط M3U'); return null; }
        payload = { mode: 'm3u', m3uUrl };
      }

      const json = JSON.stringify(payload);
      const b64 = btoa(unescape(encodeURIComponent(json)))
        .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      return window.location.origin + '/' + b64 + '/manifest.json';
    }

    function installStremio() {
      const url = buildManifestUrl();
      if (!url) return;
      window.location.href = url.replace(/^https?:\\/\\//, 'stremio://');
    }

    function copyManifest() {
      const url = buildManifestUrl();
      if (!url) return;
      navigator.clipboard.writeText(url);
      document.getElementById('output').textContent = 'تم النسخ: ' + url;
    }
  </script>
</body>
</html>`;

app.get('/', (req, res) => res.redirect('/configure'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/configure', (req, res) => res.send(CONFIG_HTML));
app.get('/:config/configure', (req, res) => res.send(CONFIG_HTML));

// Manifest افتراضي يوجه المستخدم لصفحة الإعدادات
app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'org.custom.iptv.addon',
    version: '1.0.0',
    name: 'My IPTV (Xtream & M3U)',
    description: 'قم بربط قنواتك المباشرة ومكتبة الأفلام والمسلسلات في Stremio',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv', 'movie', 'series'],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: true
    }
  });
});

// =======================
// 1. Dynamic Manifest
// =======================
app.get('/:config/manifest.json', async (req, res) => {
  const cfg = decodeConfig(req.params.config);
  if (!cfg) return res.status(400).json({ error: 'Invalid config' });

  let catalogs = [];
  let types = ['tv'];
  let idPrefixes = ['m3u_'];

  if (cfg.mode === 'xtream') {
    const [liveCats, vodCats, seriesCats] = await Promise.all([
      getXtreamCategoryMap(cfg, 'get_live_categories'),
      getXtreamCategoryMap(cfg, 'get_vod_categories'),
      getXtreamCategoryMap(cfg, 'get_series_categories')
    ]);

    types = ['tv', 'movie', 'series'];
    idPrefixes = ['xt_live_', 'xt_vod_', 'xt_ser_'];

    catalogs = [
      {
        type: 'tv',
        id: 'iptv_live',
        name: 'IPTV قنوات مباشرة',
        extra: [
          { name: 'genre', isRequired: false, options: liveCats.names },
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      },
      {
        type: 'movie',
        id: 'iptv_movies',
        name: 'IPTV أفلام',
        extra: [
          { name: 'genre', isRequired: false, options: vodCats.names },
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      },
      {
        type: 'series',
        id: 'iptv_series',
        name: 'IPTV مسلسلات',
        extra: [
          { name: 'genre', isRequired: false, options: seriesCats.names },
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      }
    ];
  } else if (cfg.mode === 'm3u') {
    let groups = [];
    try {
      const parsed = await getM3UItems(cfg.m3uUrl);
      groups = parsed.groups;
    } catch {}

    catalogs = [
      {
        type: 'tv',
        id: 'm3u_live',
        name: 'IPTV M3U قائمة',
        extra: [
          { name: 'genre', isRequired: false, options: groups },
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      }
    ];
  }

  res.json({
    id: `org.custom.iptv.${cfg.mode}`,
    version: '1.0.0',
    name: cfg.mode === 'xtream' ? 'IPTV Xtream' : 'IPTV M3U',
    description: 'قنوات مباشرة، أفلام، ومسلسلات من اشتراكك الخاص',
    resources: ['catalog', 'meta', 'stream'],
    types,
    idPrefixes,
    catalogs,
    behaviorHints: { configurable: true }
  });
});

// =======================
// 2. Catalog Handler
// =======================
async function handleCatalog(req, res) {
  const cfg = decodeConfig(req.params.config);
  if (!cfg) return res.json({ metas: [] });

  const { id } = req.params;
  const extraParams = new URLSearchParams(req.params.extra || '');
  const genre = extraParams.get('genre');
  const search = (extraParams.get('search') || '').toLowerCase();
  const skip = parseInt(extraParams.get('skip') || '0', 10) || 0;

  try {
    if (cfg.mode === 'm3u' && id === 'm3u_live') {
      const { items } = await getM3UItems(cfg.m3uUrl);
      let filtered = items;
      if (genre) filtered = filtered.filter((c) => c.group === genre);
      if (search) filtered = filtered.filter((c) => c.name.toLowerCase().includes(search));

      const metas = filtered.slice(skip, skip + PAGE_SIZE).map((c) => ({
        id: c.id,
        type: 'tv',
        name: c.name,
        poster: c.poster || undefined,
        posterShape: 'square',
        genres: [c.group]
      }));
      return res.json({ metas });
    }

    if (cfg.mode === 'xtream') {
      if (id === 'iptv_live') {
        const [{ map }, streams] = await Promise.all([
          getXtreamCategoryMap(cfg, 'get_live_categories'),
          xtreamApi(cfg, 'get_live_streams')
        ]);
        let list = Array.isArray(streams) ? streams : [];
        if (genre) list = list.filter((s) => map[String(s.category_id)] === genre);
        if (search) list = list.filter((s) => (s.name || '').toLowerCase().includes(search));

        const metas = list.slice(skip, skip + PAGE_SIZE).map((s) => ({
          id: `xt_live_${s.stream_id}`,
          type: 'tv',
          name: s.name,
          poster: s.stream_icon || undefined,
          posterShape: 'square',
          genres: map[String(s.category_id)] ? [map[String(s.category_id)]] : []
        }));
        return res.json({ metas });
      }

      if (id === 'iptv_movies') {
        const [{ map }, streams] = await Promise.all([
          getXtreamCategoryMap(cfg, 'get_vod_categories'),
          xtreamApi(cfg, 'get_vod_streams')
        ]);
        let list = Array.isArray(streams) ? streams : [];
        if (genre) list = list.filter((s) => map[String(s.category_id)] === genre);
        if (search) list = list.filter((s) => (s.name || '').toLowerCase().includes(search));

        const metas = list.slice(skip, skip + PAGE_SIZE).map((s) => ({
          id: `xt_vod_${s.stream_id}_${s.container_extension || 'mp4'}`,
          type: 'movie',
          name: s.name,
          poster: s.stream_icon || undefined,
          posterShape: 'poster',
          imdbRating: s.rating ? String(s.rating) : undefined,
          genres: map[String(s.category_id)] ? [map[String(s.category_id)]] : []
        }));
        return res.json({ metas });
      }

      if (id === 'iptv_series') {
        const [{ map }, series] = await Promise.all([
          getXtreamCategoryMap(cfg, 'get_series_categories'),
          xtreamApi(cfg, 'get_series')
        ]);
        let list = Array.isArray(series) ? series : [];
        if (genre) list = list.filter((s) => map[String(s.category_id)] === genre);
        if (search) list = list.filter((s) => (s.name || '').toLowerCase().includes(search));

        const metas = list.slice(skip, skip + PAGE_SIZE).map((s) => ({
          id: `xt_ser_${s.series_id}`,
          type: 'series',
          name: s.name,
          poster: s.cover || undefined,
          posterShape: 'poster',
          description: s.plot || undefined,
          imdbRating: s.rating ? String(s.rating) : undefined,
          genres: map[String(s.category_id)] ? [map[String(s.category_id)]] : []
        }));
        return res.json({ metas });
      }
    }
  } catch (err) {
    console.error('Catalog Error:', err.message);
  }

  res.json({ metas: [] });
}

app.get('/:config/catalog/:type/:id.json', handleCatalog);
app.get('/:config/catalog/:type/:id/:extra.json', handleCatalog);

// =======================
// 3. Meta Handler
// =======================
app.get('/:config/meta/:type/:id.json', async (req, res) => {
  const cfg = decodeConfig(req.params.config);
  if (!cfg) return res.json({ meta: null });

  const { id } = req.params;

  try {
    // قنوات M3U
    if (cfg.mode === 'm3u' && id.startsWith('m3u_ch_')) {
      const { items } = await getM3UItems(cfg.m3uUrl);
      const item = items.find((c) => c.id === id);
      if (!item) return res.json({ meta: null });
      return res.json({
        meta: {
          id: item.id,
          type: 'tv',
          name: item.name,
          poster: item.poster || undefined,
          posterShape: 'square',
          description: `التصنيف: ${item.group}`
        }
      });
    }

    // قنوات Xtream المباشرة
    if (id.startsWith('xt_live_')) {
      const streamId = id.replace('xt_live_', '');
      const streams = await xtreamApi(cfg, 'get_live_streams');
      const item = Array.isArray(streams)
        ? streams.find((s) => String(s.stream_id) === streamId)
        : null;
      return res.json({
        meta: {
          id,
          type: 'tv',
          name: item ? item.name : `Channel ${streamId}`,
          poster: item?.stream_icon || undefined,
          posterShape: 'square'
        }
      });
    }

    // أفلام Xtream
    if (id.startsWith('xt_vod_')) {
      const parts = id.split('_');
      const vodId = parts[2];
      const info = await xtreamApi(cfg, 'get_vod_info', { vod_id: vodId });
      const movieInfo = info?.info || {};
      const movieData = info?.movie_data || {};

      return res.json({
        meta: {
          id,
          type: 'movie',
          name: movieData.name || movieInfo.name || `Movie ${vodId}`,
          poster: movieInfo.movie_image || movieInfo.cover_big || undefined,
          background: Array.isArray(movieInfo.backdrop_path) ? movieInfo.backdrop_path[0] : undefined,
          description: movieInfo.plot || movieInfo.description || '',
          releaseInfo: movieInfo.releasedate ? String(movieInfo.releasedate).slice(0, 4) : undefined,
          runtime: movieInfo.duration || undefined,
          imdbRating: movieInfo.rating ? String(movieInfo.rating) : undefined
        }
      });
    }

    // مسلسلات Xtream (جلب المواسم والحلقات)
    if (id.startsWith('xt_ser_')) {
      const seriesId = id.replace('xt_ser_', '');
      const data = await xtreamApi(cfg, 'get_series_info', { series_id: seriesId });
      const info = data?.info || {};
      const episodesObj = data?.episodes || {};
      const videos = [];

      for (const seasonNum of Object.keys(episodesObj)) {
        const eps = episodesObj[seasonNum];
        if (!Array.isArray(eps)) continue;

        for (const ep of eps) {
          const ext = ep.container_extension || 'mp4';
          videos.push({
            id: `xt_ser_ep_${ep.id}_${ext}`,
            title: ep.title || `Episode ${ep.episode_num}`,
            season: parseInt(seasonNum, 10) || 1,
            episode: parseInt(ep.episode_num, 10) || 1,
            thumbnail: ep.info?.movie_image || info.cover || undefined,
            overview: ep.info?.plot || '',
            released: ep.info?.releasedate
              ? new Date(ep.info.releasedate).toISOString()
              : new Date().toISOString()
          });
        }
      }

      videos.sort((a, b) => a.season - b.season || a.episode - b.episode);

      return res.json({
        meta: {
          id,
          type: 'series',
          name: info.name || `Series ${seriesId}`,
          poster: info.cover || undefined,
          background: Array.isArray(info.backdrop_path) ? info.backdrop_path[0] : undefined,
          description: info.plot || '',
          imdbRating: info.rating ? String(info.rating) : undefined,
          videos
        }
      });
    }
  } catch (err) {
    console.error('Meta Error:', err.message);
  }

  res.json({ meta: null });
});

// =======================
// 4. Stream Handler
// =======================
app.get('/:config/stream/:type/:id.json', async (req, res) => {
  const cfg = decodeConfig(req.params.config);
  if (!cfg) return res.json({ streams: [] });

  const { id } = req.params;

  try {
    // بث M3U
    if (cfg.mode === 'm3u' && id.startsWith('m3u_ch_')) {
      const { items } = await getM3UItems(cfg.m3uUrl);
      const item = items.find((c) => c.id === id);
      if (!item) return res.json({ streams: [] });
      return res.json({
        streams: [
          {
            name: 'IPTV M3U',
            title: item.name,
            url: item.url,
            behaviorHints: { notWebReady: true }
          }
        ]
      });
    }

    // بث Xtream مباشر (توفير HLS و TS للتوافق مع كل الأجهزة)
    if (id.startsWith('xt_live_')) {
      const streamId = id.replace('xt_live_', '');
      return res.json({
        streams: [
          {
            name: 'IPTV Live (HLS)',
            title: 'بث مباشر - مفضل للويب والتلفزيون (.m3u8)',
            url: `${cfg.host}/live/${cfg.user}/${cfg.pass}/${streamId}.m3u8`
          },
          {
            name: 'IPTV Live (TS)',
            title: 'بث مباشر - سريع للمشغل الداخلي (.ts)',
            url: `${cfg.host}/live/${cfg.user}/${cfg.pass}/${streamId}.ts`,
            behaviorHints: { notWebReady: true }
          }
        ]
      });
    }

    // بث أفلام Xtream
    if (id.startsWith('xt_vod_')) {
      const parts = id.split('_');
      const vodId = parts[2];
      const ext = parts.slice(3).join('_') || 'mp4';
      return res.json({
        streams: [
          {
            name: 'IPTV Movie',
            title: `تشغيل الفيلم (${ext.toUpperCase()})`,
            url: `${cfg.host}/movie/${cfg.user}/${cfg.pass}/${vodId}.${ext}`,
            behaviorHints: { notWebReady: ext !== 'mp4' }
          }
        ]
      });
    }

    // بث حلقات مسلسلات Xtream
    if (id.startsWith('xt_ser_ep_')) {
      const parts = id.split('_');
      const epId = parts[3];
      const ext = parts.slice(4).join('_') || 'mp4';
      return res.json({
        streams: [
          {
            name: 'IPTV Series',
            title: `تشغيل الحلقة (${ext.toUpperCase()})`,
            url: `${cfg.host}/series/${cfg.user}/${cfg.pass}/${epId}.${ext}`,
            behaviorHints: { notWebReady: ext !== 'mp4' }
          }
        ]
      });
    }
  } catch (err) {
    console.error('Stream Error:', err.message);
  }

  res.json({ streams: [] });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Stremio IPTV Add-on running on port ${PORT}`);
});
