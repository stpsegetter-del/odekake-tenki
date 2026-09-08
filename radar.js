/* =========================================================================
   radar.js  —  雨雲レーダー
   ---------------------------------------------------------------------
   ・雨雲：気象庁「高解像度降水ナウキャスト」（無料・APIキー不要）
   ・地図：国土地理院の淡色地図タイル（無料・APIキー不要）
   ・地図ライブラリは使わず、タイルを自前で並べています（軽さのため）。
   ・登録した場所を中心に固定しています。指でドラッグして動かす作りに
     すると、ページを縦にスクロールできなくなって使いにくいためです。
     見る範囲は ＋ − ボタンで変えられます。
   ========================================================================= */
(function (global) {
  'use strict';

  const TILE = 256;

  const GSI_TILE = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
  const JMA_OBS = 'https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json';
  const JMA_FC = 'https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N2.json';
  const JMA_TILE = 'https://www.jma.go.jp/bosai/jmatile/data/nowc/' +
                   '{basetime}/none/{validtime}/surf/hrpns/{z}/{x}/{y}.png';

  const ZOOM_MIN = 7;
  const ZOOM_MAX = 12;
  const FRAME_MS = 480;
  const TIMES_TTL = 4 * 60 * 1000;   // 時刻一覧の取り直しは4分に1回まで

  // 気象庁ナウキャストの色（1時間あたりの雨量 mm）
  const LEGEND = [
    { c: '#a0d2ff', v: '1' },
    { c: '#218cff', v: '5' },
    { c: '#0041ff', v: '10' },
    { c: '#faf500', v: '20' },
    { c: '#ff9900', v: '30' },
    { c: '#ff2800', v: '50' },
    { c: '#b40068', v: '80' }
  ];

  /* ---------------- 状態 ---------------- */
  const S = {
    el: {},            // DOM
    place: null,
    zoom: 10,
    frames: [],        // [{basetime, validtime, date, forecast}]
    nowIndex: 0,       // 「いま」のコマ
    index: 0,          // 表示中のコマ
    playing: false,
    timer: 0,
    timesFetchedAt: 0,
    built: false,
    ready: false
  };

  /* ---------------- 座標の計算 ---------------- */
  function lonToTileX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }

  function latToTileY(lat, z) {
    const r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
  }

  /** 日本国内かどうか（気象庁のレーダーは日本のみ） */
  function inJapan(lat, lon) {
    return lat >= 20 && lat <= 46.5 && lon >= 122 && lon <= 154;
  }

  /* ---------------- 時刻 ---------------- */

  /** "20260908110500"（UTC）→ Date */
  function parseJmaTime(s) {
    const t = String(s);
    return new Date(Date.UTC(
      +t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8),
      +t.slice(8, 10), +t.slice(10, 12), +t.slice(12, 14)));
  }

  function hhmm(d) {
    return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function fetchJson(url) {
    return fetch(url, { mode: 'cors', cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  /**
   * 表示するコマを組み立てる。
   * 過去30分（10分おき）＋いま＋この先60分（10分おき）＝ 全10コマ。
   * 5分おきにすると通信量が倍になるので、10分おきにしています。
   */
  function loadFrames() {
    const fresh = Date.now() - S.timesFetchedAt < TIMES_TTL;
    if (fresh && S.frames.length) return Promise.resolve(S.frames);

    return Promise.all([
      fetchJson(JMA_OBS).catch(() => []),
      fetchJson(JMA_FC).catch(() => [])
    ]).then(([obs, fc]) => {
      const past = [];
      // obs は新しい順。10分おき（=2件おき）に、いまを含めて4コマ取る。
      for (let i = 6; i >= 0; i -= 2) {
        if (obs[i]) past.push(makeFrame(obs[i], false));
      }
      // 予測は古い順に並べ直し、「いま」より後のものだけを10分おきに拾う。
      // 気象庁の実況と予測は基準時刻がずれることがあるので、
      // 添字ではなく実際の時刻で切り分けている。
      const nowT = past.length ? past[past.length - 1].date.getTime() : Date.now();
      const cand = fc.slice().reverse()
        .map((row) => makeFrame(row, true))
        .filter((f) => f.date.getTime() > nowT + 60 * 1000);

      const future = [];
      for (let i = 1; i < cand.length && future.length < 6; i += 2) {
        future.push(cand[i]);
      }
      S.frames = past.concat(future);
      S.nowIndex = Math.max(0, past.length - 1);
      S.index = S.nowIndex;
      S.timesFetchedAt = Date.now();
      return S.frames;
    });
  }

  function makeFrame(row, forecast) {
    return {
      basetime: row.basetime,
      validtime: row.validtime,
      date: parseJmaTime(row.validtime),
      forecast: !!forecast
    };
  }

  /* ---------------- タイルを並べる ---------------- */

  function tileHtml(template, ctx, extra) {
    const n = Math.pow(2, ctx.z);
    const originX = ctx.fx * TILE - ctx.w / 2;
    const originY = ctx.fy * TILE - ctx.h / 2;
    const x0 = Math.floor(originX / TILE), x1 = Math.floor((originX + ctx.w) / TILE);
    const y0 = Math.floor(originY / TILE), y1 = Math.floor((originY + ctx.h) / TILE);

    let html = '';
    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % n) + n) % n;
        const url = template
          .replace('{z}', ctx.z).replace('{x}', wx).replace('{y}', ty)
          .replace('{basetime}', extra ? extra.basetime : '')
          .replace('{validtime}', extra ? extra.validtime : '');
        const left = Math.round(tx * TILE - originX);
        const top = Math.round(ty * TILE - originY);
        html += `<img class="radar__tile" src="${url}" alt="" decoding="async" ` +
                `style="left:${left}px;top:${top}px">`;
      }
    }
    return html;
  }

  function viewContext() {
    const box = S.el.map.getBoundingClientRect();
    return {
      z: S.zoom,
      w: Math.max(1, Math.round(box.width)),
      h: Math.max(1, Math.round(box.height)),
      fx: lonToTileX(S.place.lon, S.zoom),
      fy: latToTileY(S.place.lat, S.zoom)
    };
  }

  /** 地図と、雨雲のコマを組み立て直す */
  function build() {
    if (!S.place) return;
    const ctx = viewContext();

    S.el.base.innerHTML = tileHtml(GSI_TILE, ctx, null);

    let html = '';
    for (let i = 0; i < S.frames.length; i++) {
      html += `<div class="radar__frame" data-i="${i}"${i === S.index ? '' : ' hidden'}></div>`;
    }
    S.el.frames.innerHTML = html;
    S.built = true;

    ensureFrame(S.index);
    updateTimeLabel();

    // 表示中のコマを見せたあと、残りを順に先読みしておく
    setTimeout(prefetchRest, 800);
  }

  function ensureFrame(i) {
    const el = S.el.frames.children[i];
    if (!el || el.dataset.loaded === '1') return;
    const f = S.frames[i];
    if (!f) return;
    el.innerHTML = tileHtml(JMA_TILE, viewContext(), f);
    el.dataset.loaded = '1';
  }

  let prefetchTimer = 0;
  function prefetchRest() {
    clearTimeout(prefetchTimer);
    let i = 0;
    const step = () => {
      while (i < S.frames.length && S.el.frames.children[i] &&
             S.el.frames.children[i].dataset.loaded === '1') i++;
      if (i >= S.frames.length) return;
      ensureFrame(i);
      i++;
      prefetchTimer = setTimeout(step, 120);
    };
    step();
  }

  function showFrame(i) {
    if (!S.frames.length) return;
    S.index = Math.max(0, Math.min(S.frames.length - 1, i));
    ensureFrame(S.index);
    const kids = S.el.frames.children;
    for (let k = 0; k < kids.length; k++) kids[k].hidden = (k !== S.index);
    S.el.slider.value = String(S.index);
    updateTimeLabel();
  }

  function updateTimeLabel() {
    const f = S.frames[S.index];
    if (!f) { S.el.time.textContent = ''; return; }
    const base = S.frames[S.nowIndex];
    const diff = base ? Math.round((f.date - base.date) / 60000) : 0;
    const tag = diff === 0 ? 'いま' : (diff < 0 ? `${-diff}分前` : `${diff}分後`);
    S.el.time.textContent = `${hhmm(f.date)}　${tag}`;
    S.el.map.setAttribute('data-forecast', f.forecast ? '1' : '0');
  }

  /* ---------------- 再生 ---------------- */
  function play() {
    if (S.playing || S.frames.length < 2) return;
    S.playing = true;
    S.el.play.setAttribute('aria-label', '一時停止');
    S.el.play.classList.add('is-playing');
    S.timer = setInterval(() => {
      let next = S.index + 1;
      if (next >= S.frames.length) next = 0;
      showFrame(next);
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

  function setZoom(z) {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    if (next === S.zoom) return;
    S.zoom = next;
    S.el.zoomIn.disabled = S.zoom >= ZOOM_MAX;
    S.el.zoomOut.disabled = S.zoom <= ZOOM_MIN;
    // コマを作り直す（ズームが変わるとタイルが全部変わるため）
    for (const k of S.el.frames.children) k.dataset.loaded = '';
    build();
  }

  /* ---------------- 外に出す関数 ---------------- */

  function init() {
    S.el = {
      card: document.getElementById('radarCard'),
      map: document.getElementById('radarMap'),
      base: document.getElementById('radarBase'),
      frames: document.getElementById('radarFrames'),
      time: document.getElementById('radarTime'),
      note: document.getElementById('radarNote'),
      play: document.getElementById('radarPlay'),
      slider: document.getElementById('radarSlider'),
      zoomIn: document.getElementById('radarZoomIn'),
      zoomOut: document.getElementById('radarZoomOut'),
      legend: document.getElementById('radarLegend')
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

    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

    let rt = 0;
    global.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        if (!S.ready || !S.built) return;
        for (const k of S.el.frames.children) k.dataset.loaded = '';
        build();
      }, 250);
    }, { passive: true });

    S.ready = true;
  }

  /**
   * 表示する場所を決める。地点を切り替えたときに呼びます。
   */
  function setPlace(place) {
    if (!S.ready || !place) return;
    pause();
    S.place = place;

    if (!inJapan(place.lat, place.lon)) {
      S.el.card.hidden = false;
      S.el.map.hidden = true;
      S.el.frames.innerHTML = '';
      S.el.time.textContent = '';
      S.el.card.setAttribute('data-state', 'unsupported');
      setNote('雨雲レーダーは日本国内のみ対応しています。');
      return;
    }

    S.el.card.hidden = false;
    S.el.map.hidden = false;
    S.el.card.setAttribute('data-state', 'loading');
    setNote('');

    loadFrames()
      .then((frames) => {
        if (!frames.length) throw new Error('no frames');
        // 場所を切り替えたときは、必ず「いま」から見せる
        S.index = S.nowIndex;
        S.el.slider.max = String(frames.length - 1);
        S.el.slider.value = String(S.index);
        S.el.zoomIn.disabled = S.zoom >= ZOOM_MAX;
        S.el.zoomOut.disabled = S.zoom <= ZOOM_MIN;
        for (const k of S.el.frames.children) k.dataset.loaded = '';
        build();
        S.el.card.setAttribute('data-state', 'ok');
      })
      .catch(() => {
        S.el.card.setAttribute('data-state', 'error');
        S.el.map.hidden = true;
        setNote('雨雲の情報を取得できませんでした。通信状況を確かめてください。');
      });
  }

  /** 予報を更新したときに、レーダーも新しくする */
  function refresh() {
    if (!S.ready || !S.place) return;
    S.timesFetchedAt = 0;
    setPlace(S.place);
  }

  global.Radar = { init, setPlace, refresh, pause, get playing() { return S.playing; } };

})(window);
