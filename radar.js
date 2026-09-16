/* =========================================================================
   radar.js  —  雨雲レーダー（2つの見方）
   ---------------------------------------------------------------------
   【いま】5分ごと・1時間先まで
       気象庁「高解像度降水ナウキャスト」のタイル画像。
       レーダーが捉えた雨雲そのもの。いちばん正確ですが、
       気象庁の配信が60分先までなので、それ以上は見られません。

   【この先24時間】1時間ごと
       Open-Meteo から周辺の格子状の降水予報をまとめて取り、
       地図の上に色で重ねています。数値予報モデルの予想なので、
       ナウキャストほど細かくはありませんが、1日先まで見通せます。

   どちらも無料・APIキー不要。地図は国土地理院のタイルです。
   地図ライブラリは使わず、タイルと色塗りを自前で行っています。
   ========================================================================= */
(function (global) {
  'use strict';

  const TILE = 256;

  const GSI_TILE = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
  const JMA_FC = 'https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N2.json';
  const JMA_OBS = 'https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json';
  const JMA_TILE = 'https://www.jma.go.jp/bosai/jmatile/data/nowc/' +
                   '{basetime}/none/{validtime}/surf/hrpns/{z}/{x}/{y}.png';
  const OM_FORECAST = 'https://api.open-meteo.com/v1/forecast';

  /* 気象庁が実データを持つズームは偶数だけ（奇数は中身が空のPNGが返る）。
     それより細かく見たいときは、1段粗いタイルを引き伸ばして重ねる。 */
  const RAIN_ZOOMS = [4, 6, 8, 10];

  const ZOOM_MIN = 5;
  const ZOOM_MAX = 15;
  const ZOOM_DEFAULT = 10;

  const FRAME_MS = 380;
  const TIMES_TTL = 4 * 60 * 1000;
  const GRID_TTL = 15 * 60 * 1000;
  const GRID_N = 11;            // 11×11=121地点（実測 約105KB / 約2秒）
  const GRID_HOURS = 25;        // いまを含めて25コマ＝24時間先まで

  // 気象庁ナウキャストと同じ色づかい（1時間あたりの雨量 mm）
  const LEGEND = [
    { c: '#a0d2ff', v: '1' },
    { c: '#218cff', v: '5' },
    { c: '#0041ff', v: '10' },
    { c: '#faf500', v: '20' },
    { c: '#ff9900', v: '30' },
    { c: '#ff2800', v: '50' },
    { c: '#b40068', v: '80' }
  ];

  // 24時間モードの色分け（しきい値 mm/h → 色）
  const HEAT_SCALE = [
    [1, [200, 230, 255]],
    [5, [160, 210, 255]],
    [10, [33, 140, 255]],
    [20, [0, 65, 255]],
    [30, [250, 245, 0]],
    [50, [255, 153, 0]],
    [80, [255, 40, 0]],
    [Infinity, [180, 0, 104]]
  ];

  const HINTS = {
    now: '中心の印があなたの場所です。5分ごとに、いまから1時間先まで見られます。' +
         '気象庁のレーダーが捉えた雨雲そのものなので、直前の判断に向いています。',
    day: '中心の印があなたの場所です。1時間ごとに、24時間先まで見られます。' +
         '予報モデルによる予想のため、粗いぼんやりした形になります。細かい雨雲の形は「いま」でご確認ください。'
  };

  const SOURCE = {
    now: '雨雲：気象庁 高解像度降水ナウキャスト／地図：国土地理院',
    day: '雨の予想：Open-Meteo（国内は気象庁モデル）／地図：国土地理院'
  };

  /* ---------------- 状態 ---------------- */
  const S = {
    el: {},
    place: null,
    zoom: ZOOM_DEFAULT,
    mode: 'now',
    frames: [],
    index: 0,
    timesFetchedAt: 0,
    grid: null,
    gridKey: '',
    gridAt: 0,
    playing: false,
    timer: 0,
    ready: false
  };

  /* ---------------- 座標 ---------------- */
  const lonToTileX = (lon, z) => (lon + 180) / 360 * Math.pow(2, z);

  function latToTileY(lat, z) {
    const r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
  }

  const tileXToLon = (x, z) => x / Math.pow(2, z) * 360 - 180;

  function tileYToLat(y, z) {
    const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  function rainZoomFor(z) {
    let best = RAIN_ZOOMS[0];
    for (const s of RAIN_ZOOMS) if (s <= z) best = s;
    return best;
  }

  const inJapan = (lat, lon) => lat >= 20 && lat <= 46.5 && lon >= 122 && lon <= 154;

  function viewSize() {
    const b = S.el.map.getBoundingClientRect();
    return { w: Math.max(1, Math.round(b.width)), h: Math.max(1, Math.round(b.height)) };
  }

  /** 画面に写っている範囲の緯度経度 */
  function viewBounds() {
    const v = viewSize();
    const z = S.zoom;
    const ox = lonToTileX(S.place.lon, z) * TILE - v.w / 2;
    const oy = latToTileY(S.place.lat, z) * TILE - v.h / 2;
    return {
      west: tileXToLon(ox / TILE, z),
      east: tileXToLon((ox + v.w) / TILE, z),
      north: tileYToLat(oy / TILE, z),
      south: tileYToLat((oy + v.h) / TILE, z)
    };
  }

  /** 緯度経度 → 画面の位置 */
  function projector() {
    const v = viewSize();
    const z = S.zoom;
    const ox = lonToTileX(S.place.lon, z) * TILE - v.w / 2;
    const oy = latToTileY(S.place.lat, z) * TILE - v.h / 2;
    return {
      x: (lon) => lonToTileX(lon, z) * TILE - ox,
      y: (lat) => latToTileY(lat, z) * TILE - oy
    };
  }

  /* ---------------- 時刻 ---------------- */
  function parseJmaTime(s) {
    const t = String(s);
    return new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8),
      +t.slice(8, 10), +t.slice(10, 12), +t.slice(12, 14)));
  }

  /** "2026-09-12T08:00"（現地時間）→ Date */
  function parseLocalTime(s) {
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
  }

  const hhmm = (d) => d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');

  function relLabel(min) {
    if (min <= 0) return 'いま';
    const body = min >= 60
      ? `${Math.floor(min / 60)}時間${min % 60 ? (min % 60) + '分' : ''}`
      : `${min}分`;
    return body + '後';
  }

  function fetchJson(url) {
    return fetch(url, { mode: 'cors', cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  /* =====================================================================
     いま（気象庁ナウキャスト・5分ごと）
     ===================================================================== */
  function loadNowFrames() {
    if (S.nowFrames && Date.now() - S.timesFetchedAt < TIMES_TTL) {
      return Promise.resolve(S.nowFrames);
    }
    return Promise.all([
      fetchJson(JMA_OBS).catch(() => []),
      fetchJson(JMA_FC).catch(() => [])
    ]).then(([obs, fc]) => {
      // 過去は見なくてよいので、実況はいちばん新しい1コマ＝「いま」だけ使う
      const latest = obs.length ? makeTileFrame(obs[0], false) : null;
      const nowT = latest ? latest.date.getTime() : Date.now();
      const future = fc.slice().reverse()
        .map((r) => makeTileFrame(r, true))
        .filter((f) => f.date.getTime() > nowT);

      S.nowFrames = (latest ? [latest] : []).concat(future);
      S.timesFetchedAt = Date.now();
      return S.nowFrames;
    });
  }

  function makeTileFrame(row, forecast) {
    return {
      kind: 'tile',
      basetime: row.basetime,
      validtime: row.validtime,
      date: parseJmaTime(row.validtime),
      forecast: !!forecast
    };
  }

  function tileHtml(template, o) {
    const scale = Math.pow(2, o.z - o.sz);
    const ts = TILE * scale;
    const n = Math.pow(2, o.sz);
    const originX = lonToTileX(o.lon, o.sz) * ts - o.w / 2;
    const originY = latToTileY(o.lat, o.sz) * ts - o.h / 2;
    const x0 = Math.floor(originX / ts), x1 = Math.floor((originX + o.w) / ts);
    const y0 = Math.floor(originY / ts), y1 = Math.floor((originY + o.h) / ts);

    let html = '';
    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % n) + n) % n;
        const url = template
          .replace('{z}', o.sz).replace('{x}', wx).replace('{y}', ty)
          .replace('{basetime}', o.extra ? o.extra.basetime : '')
          .replace('{validtime}', o.extra ? o.extra.validtime : '');
        html += `<img class="radar__tile${o.cls ? ' ' + o.cls : ''}" src="${url}" alt="" ` +
                `decoding="async" style="left:${Math.round(tx * ts - originX)}px;` +
                `top:${Math.round(ty * ts - originY)}px;width:${ts}px;height:${ts}px">`;
      }
    }
    return html;
  }

  function drawBaseMap() {
    const v = viewSize();
    S.el.base.innerHTML = tileHtml(GSI_TILE, {
      z: S.zoom, sz: S.zoom, w: v.w, h: v.h, lat: S.place.lat, lon: S.place.lon
    });
  }

  function ensureTileFrame(i) {
    const el = S.el.frames.children[i];
    if (!el || el.dataset.loaded === '1') return;
    const f = S.frames[i];
    if (!f || f.kind !== 'tile') return;
    const v = viewSize();
    const sz = rainZoomFor(S.zoom);
    el.innerHTML = tileHtml(JMA_TILE, {
      z: S.zoom, sz, w: v.w, h: v.h, lat: S.place.lat, lon: S.place.lon,
      extra: f, cls: sz < S.zoom ? 'radar__tile--zoomed' : ''
    });
    el.dataset.loaded = '1';
  }

  /* =====================================================================
     この先24時間（Open-Meteo の格子予報）
     ===================================================================== */
  function loadGrid() {
    const b = viewBounds();
    const key = [S.zoom, b.north.toFixed(2), b.south.toFixed(2), b.west.toFixed(2), b.east.toFixed(2)].join('|');
    if (S.grid && S.gridKey === key && Date.now() - S.gridAt < GRID_TTL) {
      return Promise.resolve(S.grid);
    }

    // 画面より少し広めに取っておく（端が切れて見えないように）
    const padLat = (b.north - b.south) * 0.12;
    const padLon = (b.east - b.west) * 0.12;
    const north = Math.min(46.5, b.north + padLat);
    const south = Math.max(20, b.south - padLat);
    const west = Math.max(122, b.west - padLon);
    const east = Math.min(154, b.east + padLon);

    const lats = [], lons = [];
    for (let r = 0; r < GRID_N; r++) {
      // 行0が北。画像として描くときに上下がそのまま合う。
      const la = north - (north - south) * (r / (GRID_N - 1));
      for (let c = 0; c < GRID_N; c++) {
        lats.push((la).toFixed(4));
        lons.push((west + (east - west) * (c / (GRID_N - 1))).toFixed(4));
      }
    }

    const url = OM_FORECAST +
      '?latitude=' + lats.join(',') +
      '&longitude=' + lons.join(',') +
      '&hourly=precipitation&forecast_hours=' + GRID_HOURS +
      '&timezone=auto';

    return fetchJson(url).then((rows) => {
      const list = Array.isArray(rows) ? rows : [rows];
      if (!list.length || !list[0].hourly) throw new Error('no grid');

      const times = list[0].hourly.time.map(parseLocalTime);
      const nowMs = Date.now();
      // いまの時間より前のコマは捨てる（取得タイミングでずれることがある）
      const keep = [];
      for (let t = 0; t < times.length; t++) {
        if (times[t] && times[t].getTime() >= nowMs - 60 * 60 * 1000) keep.push(t);
      }

      const values = keep.map((t) => {
        const arr = new Float32Array(GRID_N * GRID_N);
        for (let k = 0; k < GRID_N * GRID_N; k++) {
          const p = list[k] && list[k].hourly && list[k].hourly.precipitation;
          const v = p ? p[t] : null;
          arr[k] = (v == null || !isFinite(v)) ? 0 : v;
        }
        return arr;
      });

      S.grid = {
        n: GRID_N, north, south, west, east,
        times: keep.map((t) => times[t]),
        values
      };
      S.gridKey = key;
      S.gridAt = Date.now();
      return S.grid;
    });
  }

  function heatColor(v) {
    if (!(v >= 0.1)) return null;
    for (const [limit, rgb] of HEAT_SCALE) if (v < limit) return rgb;
    return HEAT_SCALE[HEAT_SCALE.length - 1][1];
  }

  function drawGridFrame(i) {
    const cv = S.el.heat;
    const g = S.grid;
    if (!cv || !g) return;
    const v = viewSize();
    const dpr = Math.min(2, global.devicePixelRatio || 1);
    cv.width = Math.round(v.w * dpr);
    cv.height = Math.round(v.h * dpr);
    cv.style.width = v.w + 'px';
    cv.style.height = v.h + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, v.w, v.h);

    const vals = g.values[i];
    if (!vals) return;

    // いったん 11×11 の小さな絵にしてから、地図に合わせて引き伸ばす。
    // ブラウザの補間がかかって、なめらかな分布として見える。
    const n = g.n;
    const off = document.createElement('canvas');
    off.width = n; off.height = n;
    const octx = off.getContext('2d');
    const img = octx.createImageData(n, n);
    for (let k = 0; k < n * n; k++) {
      const rgb = heatColor(vals[k]);
      const p = k * 4;
      if (rgb) {
        img.data[p] = rgb[0]; img.data[p + 1] = rgb[1]; img.data[p + 2] = rgb[2];
        img.data[p + 3] = 255;
      } else {
        img.data[p + 3] = 0;
      }
    }
    octx.putImageData(img, 0, 0);

    // 格子は「点」なので、外側に半マスぶん広げて描く
    const P = projector();
    const dLat = (g.north - g.south) / (n - 1) / 2;
    const dLon = (g.east - g.west) / (n - 1) / 2;
    const x0 = P.x(g.west - dLon), x1 = P.x(g.east + dLon);
    const y0 = P.y(g.north + dLat), y1 = P.y(g.south - dLat);

    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = 0.72;
    ctx.drawImage(off, x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
    ctx.globalAlpha = 1;
  }

  /* =====================================================================
     共通の表示処理
     ===================================================================== */
  function isNowMode() { return S.mode === 'now'; }

  function buildFrames() {
    if (isNowMode()) {
      S.frames = (S.nowFrames || []).map((f) => f);
      S.el.heat.hidden = true;
      S.el.frames.hidden = false;
      let html = '';
      for (let i = 0; i < S.frames.length; i++) {
        html += `<div class="radar__frame" data-i="${i}"${i === S.index ? '' : ' hidden'}></div>`;
      }
      S.el.frames.innerHTML = html;
    } else {
      const g = S.grid;
      S.frames = g ? g.times.map((d, i) => ({ kind: 'grid', gi: i, date: d, forecast: i > 0 })) : [];
      S.el.frames.hidden = true;
      S.el.frames.innerHTML = '';
      S.el.heat.hidden = false;
    }
    if (S.index >= S.frames.length) S.index = 0;
  }

  function showFrame(i) {
    if (!S.frames.length) return;
    S.index = Math.max(0, Math.min(S.frames.length - 1, i));
    const f = S.frames[S.index];
    if (f.kind === 'tile') {
      ensureTileFrame(S.index);
      const kids = S.el.frames.children;
      for (let k = 0; k < kids.length; k++) kids[k].hidden = (k !== S.index);
    } else {
      drawGridFrame(f.gi);
    }
    S.el.slider.value = String(S.index);
    updateTimeLabel();
  }

  function updateTimeLabel() {
    const f = S.frames[S.index];
    if (!f) { S.el.time.textContent = ''; return; }
    const base = S.frames[0];
    const diff = base ? Math.round((f.date - base.date) / 60000) : 0;
    S.el.time.textContent = `${hhmm(f.date)}　${relLabel(diff)}`;
    S.el.map.setAttribute('data-forecast', f.forecast ? '1' : '0');
  }

  /** 再生でよく使うコマを、少しずつ先読みしておく（いまモードのみ） */
  let prefetchTimer = 0;
  function prefetchFrames() {
    clearTimeout(prefetchTimer);
    if (!isNowMode()) return;
    let i = 0;
    const step = () => {
      while (i < S.frames.length && S.el.frames.children[i] &&
             S.el.frames.children[i].dataset.loaded === '1') i++;
      if (i >= S.frames.length) return;
      ensureTileFrame(i);
      i++;
      prefetchTimer = setTimeout(step, 130);
    };
    step();
  }

  /* ---------------- 再生（最後まで行ったら止まる） ---------------- */
  function play() {
    if (S.playing || S.frames.length < 2) return;
    // 最後のコマで押されたときは、はじめに戻してから流す
    if (S.index >= S.frames.length - 1) showFrame(0);
    S.playing = true;
    S.el.play.setAttribute('aria-label', '一時停止');
    S.el.play.classList.add('is-playing');
    S.timer = setInterval(() => {
      if (S.index >= S.frames.length - 1) { pause(); return; }
      showFrame(S.index + 1);
    }, FRAME_MS);
  }

  function pause() {
    S.playing = false;
    clearInterval(S.timer);
    S.timer = 0;
    if (S.el.play) {
      S.el.play.setAttribute('aria-label', '再生');
      S.el.play.classList.remove('is-playing');
    }
  }

  function togglePlay() { S.playing ? pause() : play(); }

  /* ---------------- 表示の切り替え ---------------- */
  function setNote(text) {
    S.el.note.textContent = text || '';
    S.el.note.hidden = !text;
  }

  function setLoading(on) {
    if (S.el.loading) S.el.loading.hidden = !on;
  }

  function syncZoomButtons() {
    S.el.zoomIn.disabled = S.zoom >= ZOOM_MAX;
    S.el.zoomOut.disabled = S.zoom <= ZOOM_MIN;
    const zoomed = isNowMode() && rainZoomFor(S.zoom) < S.zoom;
    S.el.map.setAttribute('data-zoomed', zoomed ? '1' : '0');
  }

  function syncModeButtons() {
    Array.prototype.forEach.call(S.el.modes.children, (b) => {
      const on = b.getAttribute('data-mode') === S.mode;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    S.el.hint.textContent = HINTS[S.mode] + ' ' + SOURCE[S.mode];
  }

  /** 地図と雨を描き直す */
  function redraw() {
    if (!S.place || !S.frames.length) return;
    drawBaseMap();
    if (isNowMode()) {
      for (const k of S.el.frames.children) k.dataset.loaded = '';
    }
    showFrame(S.index);
    setTimeout(prefetchFrames, 500);
  }

  function setZoom(z) {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    if (next === S.zoom) return;
    pause();
    S.zoom = next;
    syncZoomButtons();

    if (isNowMode()) {
      redraw();
    } else {
      // 24時間モードは、見る範囲が変わったら取り直す
      setLoading(true);
      drawBaseMap();
      loadGrid()
        .then(() => { buildFrames(); showFrame(S.index); })
        .catch(() => setNote('雨の予想を取得できませんでした。'))
        .finally(() => setLoading(false));
    }
  }

  function setMode(mode) {
    if (mode === S.mode) return;
    pause();
    S.mode = mode;
    S.index = 0;
    syncModeButtons();
    syncZoomButtons();
    S.el.card.setAttribute('data-mode', mode);
    setNote('');
    setLoading(true);

    const job = isNowMode() ? loadNowFrames() : loadGrid();
    job.then(() => {
      buildFrames();
      S.el.slider.max = String(Math.max(0, S.frames.length - 1));
      redraw();
    }).catch(() => {
      setNote(isNowMode()
        ? '雨雲の情報を取得できませんでした。'
        : '雨の予想を取得できませんでした。通信状況を確かめてください。');
    }).finally(() => setLoading(false));
  }

  /* ---------------- 外に出す関数 ---------------- */
  function init() {
    S.el = {
      card: document.getElementById('radarCard'),
      map: document.getElementById('radarMap'),
      base: document.getElementById('radarBase'),
      frames: document.getElementById('radarFrames'),
      heat: document.getElementById('radarHeat'),
      loading: document.getElementById('radarLoading'),
      modes: document.getElementById('radarModes'),
      time: document.getElementById('radarTime'),
      note: document.getElementById('radarNote'),
      hint: document.getElementById('radarHint'),
      play: document.getElementById('radarPlay'),
      slider: document.getElementById('radarSlider'),
      zoomIn: document.getElementById('radarZoomIn'),
      zoomOut: document.getElementById('radarZoomOut'),
      legend: document.getElementById('radarLegend'),
      now: document.getElementById('radarNow')
    };
    if (!S.el.card) return;

    S.el.legend.innerHTML =
      '<span class="radar__legend-cap">弱</span>' +
      LEGEND.map((l) =>
        `<span class="radar__legend-item"><i style="background:${l.c}"></i><em>${l.v}</em></span>`).join('') +
      '<span class="radar__legend-cap">強</span>';

    S.el.play.addEventListener('click', togglePlay);
    S.el.zoomIn.addEventListener('click', () => setZoom(S.zoom + 1));
    S.el.zoomOut.addEventListener('click', () => setZoom(S.zoom - 1));
    S.el.slider.addEventListener('input', () => { pause(); showFrame(Number(S.el.slider.value)); });
    if (S.el.now) S.el.now.addEventListener('click', () => { pause(); showFrame(0); });

    S.el.modes.addEventListener('click', (e) => {
      const b = e.target.closest('.radar-mode');
      if (b) setMode(b.getAttribute('data-mode'));
    });

    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

    let rt = 0;
    global.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => { if (S.ready && S.frames.length) redraw(); }, 250);
    }, { passive: true });

    S.ready = true;
  }

  function setPlace(place) {
    if (!S.ready || !place) return;
    pause();
    S.place = place;
    S.grid = null;
    S.gridKey = '';

    if (!inJapan(place.lat, place.lon)) {
      S.el.card.hidden = false;
      S.el.map.hidden = true;
      S.el.modes.hidden = true;
      S.el.frames.innerHTML = '';
      S.el.time.textContent = '';
      S.el.card.setAttribute('data-state', 'unsupported');
      setNote('雨雲レーダーは日本国内のみ対応しています。');
      return;
    }

    S.el.card.hidden = false;
    S.el.map.hidden = false;
    S.el.modes.hidden = false;
    S.el.card.setAttribute('data-state', 'loading');
    S.el.card.setAttribute('data-mode', S.mode);
    setNote('');
    setLoading(true);
    syncModeButtons();

    const job = isNowMode() ? loadNowFrames() : loadGrid();
    job.then(() => {
      buildFrames();
      if (!S.frames.length) throw new Error('no frames');
      S.index = 0;
      S.el.slider.max = String(S.frames.length - 1);
      S.el.slider.value = '0';
      syncZoomButtons();
      redraw();
      S.el.card.setAttribute('data-state', 'ok');
    }).catch(() => {
      S.el.card.setAttribute('data-state', 'error');
      S.el.map.hidden = true;
      setNote('雨の情報を取得できませんでした。通信状況を確かめてください。');
    }).finally(() => setLoading(false));
  }

  function refresh() {
    if (!S.ready || !S.place) return;
    S.timesFetchedAt = 0;
    S.nowFrames = null;
    S.grid = null;
    S.gridKey = '';
    setPlace(S.place);
  }

  global.Radar = {
    init, setPlace, refresh, pause,
    get playing() { return S.playing; },
    get mode() { return S.mode; },
    get zoom() { return S.zoom; }
  };

})(window);
