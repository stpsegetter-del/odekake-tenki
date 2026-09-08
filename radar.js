/* =========================================================================
   radar.js  —  雨雲レーダー
   ---------------------------------------------------------------------
   ・雨雲：気象庁「高解像度降水ナウキャスト」（無料・APIキー不要）
     5分きざみで、実況は過去3時間ぶん、予測は60分先まで。
     ※60分より先の雨雲は気象庁から配信されていません。レーダーの雨雲を
       追いかける予測は、原理的に1時間先あたりが限界のためです。
       それより先は、画面上の「これから12時間」のグラフをご覧ください。
   ・地図：国土地理院の淡色地図タイル（無料・APIキー不要）
   ・地図ライブラリは使わず、タイルを自前で並べています（軽さのため）。
   ・登録した場所を中心に固定しています。指でドラッグして動かす作りに
     すると、ページを縦にスクロールできなくなって使いにくいためです。
   ========================================================================= */
(function (global) {
  'use strict';

  const TILE = 256;

  const GSI_TILE = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
  const JMA_OBS = 'https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json';
  const JMA_FC = 'https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N2.json';
  const JMA_TILE = 'https://www.jma.go.jp/bosai/jmatile/data/nowc/' +
                   '{basetime}/none/{validtime}/surf/hrpns/{z}/{x}/{y}.png';

  /* 気象庁が実データを持つズームは偶数だけ（奇数は中身が空のPNGが返る）。
     地図側は全ズームあるので、雨雲だけ1段下のタイルを拡大して重ねる。 */
  const RAIN_ZOOMS = [4, 6, 8, 10];

  const ZOOM_MIN = 6;
  const ZOOM_MAX = 12;
  const ZOOM_DEFAULT = 10;

  const FRAME_MS = 380;
  const PLAY_BACK_STEPS = 6;         // 再生は「30分前」から始める（5分×6）
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
    el: {},
    place: null,
    zoom: ZOOM_DEFAULT,
    frames: [],
    nowIndex: 0,
    index: 0,
    playing: false,
    timer: 0,
    timesFetchedAt: 0,
    ready: false
  };

  /* ---------------- 座標の計算 ---------------- */
  function lonToTileX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }

  function latToTileY(lat, z) {
    const r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
  }

  /** 表示ズームに対して、雨雲タイルを取りに行くズーム */
  function rainZoomFor(z) {
    let best = RAIN_ZOOMS[0];
    for (const s of RAIN_ZOOMS) if (s <= z) best = s;
    return best;
  }

  function inJapan(lat, lon) {
    return lat >= 20 && lat <= 46.5 && lon >= 122 && lon <= 154;
  }

  /* ---------------- 時刻 ---------------- */
  function parseJmaTime(s) {
    const t = String(s);
    return new Date(Date.UTC(
      +t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8),
      +t.slice(8, 10), +t.slice(10, 12), +t.slice(12, 14)));
  }

  function hhmm(d) {
    return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /** -95 → 「1時間35分前」 / 0 → 「いま」 / 30 → 「30分後」 */
  function relLabel(min) {
    if (min === 0) return 'いま';
    const a = Math.abs(min);
    const body = a >= 60
      ? `${Math.floor(a / 60)}時間${a % 60 ? (a % 60) + '分' : ''}`
      : `${a}分`;
    return body + (min < 0 ? '前' : '後');
  }

  function fetchJson(url) {
    return fetch(url, { mode: 'cors', cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  /**
   * 表示するコマを組み立てる。
   * 気象庁が配信している 5分きざみのコマを、そのまま全部使う。
   * （実況＝過去3時間ぶん / 予測＝60分先まで）
   */
  function loadFrames() {
    if (S.frames.length && Date.now() - S.timesFetchedAt < TIMES_TTL) {
      return Promise.resolve(S.frames);
    }
    return Promise.all([
      fetchJson(JMA_OBS).catch(() => []),
      fetchJson(JMA_FC).catch(() => [])
    ]).then(([obs, fc]) => {
      // どちらも「新しい順」で来るので、古い順に並べ直す
      const past = obs.slice().reverse().map((r) => makeFrame(r, false));
      const nowT = past.length ? past[past.length - 1].date.getTime() : Date.now();
      const future = fc.slice().reverse()
        .map((r) => makeFrame(r, true))
        .filter((f) => f.date.getTime() > nowT);

      S.frames = past.concat(future);
      S.nowIndex = Math.max(0, past.length - 1);
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

  /**
   * @param {string} template  {z}{x}{y}（と {basetime}{validtime}）を含むURL
   * @param {object} o  {z:表示ズーム, sz:取得ズーム, w, h, lat, lon, extra, cls}
   */
  function tileHtml(template, o) {
    const scale = Math.pow(2, o.z - o.sz);   // 1より大きいと拡大表示
    const ts = TILE * scale;                  // 画面上でのタイル1枚の大きさ
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
        const left = Math.round(tx * ts - originX);
        const top = Math.round(ty * ts - originY);
        html += `<img class="radar__tile${o.cls ? ' ' + o.cls : ''}" src="${url}" alt="" ` +
                `decoding="async" style="left:${left}px;top:${top}px;` +
                `width:${ts}px;height:${ts}px">`;
      }
    }
    return html;
  }

  function viewSize() {
    const box = S.el.map.getBoundingClientRect();
    return {
      w: Math.max(1, Math.round(box.width)),
      h: Math.max(1, Math.round(box.height))
    };
  }

  function baseCtx() {
    const v = viewSize();
    return { z: S.zoom, sz: S.zoom, w: v.w, h: v.h, lat: S.place.lat, lon: S.place.lon };
  }

  function rainCtx(frame) {
    const v = viewSize();
    const sz = rainZoomFor(S.zoom);
    return {
      z: S.zoom, sz, w: v.w, h: v.h, lat: S.place.lat, lon: S.place.lon,
      extra: frame,
      cls: sz < S.zoom ? 'radar__tile--zoomed' : ''
    };
  }

  /** 地図と、雨雲のコマの入れ物を組み立て直す */
  function build() {
    if (!S.place || !S.frames.length) return;

    S.el.base.innerHTML = tileHtml(GSI_TILE, baseCtx());

    let html = '';
    for (let i = 0; i < S.frames.length; i++) {
      html += `<div class="radar__frame" data-i="${i}"${i === S.index ? '' : ' hidden'}></div>`;
    }
    S.el.frames.innerHTML = html;

    ensureFrame(S.index);
    updateTimeLabel();
    setTimeout(prefetchPlayRange, 600);
  }

  function ensureFrame(i) {
    const el = S.el.frames.children[i];
    if (!el || el.dataset.loaded === '1') return;
    const f = S.frames[i];
    if (!f) return;
    el.innerHTML = tileHtml(JMA_TILE, rainCtx(f));
    el.dataset.loaded = '1';
  }

  /** 再生でよく使う範囲だけ、少しずつ先読みしておく */
  let prefetchTimer = 0;
  function prefetchPlayRange() {
    clearTimeout(prefetchTimer);
    const r = playRange();
    let i = r.from;
    const step = () => {
      while (i <= r.to && S.el.frames.children[i] &&
             S.el.frames.children[i].dataset.loaded === '1') i++;
      if (i > r.to) return;
      ensureFrame(i);
      i++;
      prefetchTimer = setTimeout(step, 130);
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
    S.el.time.textContent = `${hhmm(f.date)}　${relLabel(diff)}`;
    S.el.map.setAttribute('data-forecast', f.forecast ? '1' : '0');
  }

  /* ---------------- 再生 ---------------- */

  /** 再生する範囲：30分前 〜 いちばん先の予測 */
  function playRange() {
    return {
      from: Math.max(0, S.nowIndex - PLAY_BACK_STEPS),
      to: S.frames.length - 1
    };
  }

  function play() {
    if (S.playing || S.frames.length < 2) return;
    S.playing = true;
    S.el.play.setAttribute('aria-label', '一時停止');
    S.el.play.classList.add('is-playing');
    // 「いま」の位置で押されたときは30分前まで巻き戻す。
    // そこから流したほうが、雨雲がどちらへ動いているか分かるため。
    const r = playRange();
    if (S.index < r.from || S.index >= r.to || S.index === S.nowIndex) showFrame(r.from);
    S.timer = setInterval(() => {
      const rr = playRange();
      let next = S.index + 1;
      if (next > rr.to || S.index < rr.from) next = rr.from;
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

  function rebuildTiles() {
    for (const k of S.el.frames.children) k.dataset.loaded = '';
    build();
  }

  function setZoom(z) {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    if (next === S.zoom) return;
    S.zoom = next;
    syncZoomButtons();
    rebuildTiles();
  }

  function syncZoomButtons() {
    S.el.zoomIn.disabled = S.zoom >= ZOOM_MAX;
    S.el.zoomOut.disabled = S.zoom <= ZOOM_MIN;
    // 雨雲を拡大表示している間は、粗さの理由がわかるようにしておく
    const sz = rainZoomFor(S.zoom);
    S.el.map.setAttribute('data-zoomed', sz < S.zoom ? '1' : '0');
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
    if (S.el.now) S.el.now.addEventListener('click', () => { pause(); showFrame(S.nowIndex); });

    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

    let rt = 0;
    global.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => { if (S.ready && S.frames.length) rebuildTiles(); }, 250);
    }, { passive: true });

    S.ready = true;
  }

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
        S.index = S.nowIndex;            // 場所を変えたら必ず「いま」から
        S.el.slider.max = String(frames.length - 1);
        S.el.slider.value = String(S.index);
        syncZoomButtons();
        rebuildTiles();
        S.el.card.setAttribute('data-state', 'ok');
      })
      .catch(() => {
        S.el.card.setAttribute('data-state', 'error');
        S.el.map.hidden = true;
        setNote('雨雲の情報を取得できませんでした。通信状況を確かめてください。');
      });
  }

  function refresh() {
    if (!S.ready || !S.place) return;
    S.timesFetchedAt = 0;
    setPlace(S.place);
  }

  global.Radar = { init, setPlace, refresh, pause, get playing() { return S.playing; } };

})(window);
