/* =========================================================================
   sky.js  —  背景の空と、雨・雪のアニメーション
   ---------------------------------------------------------------------
   ・天気（晴れ/くもり/雨/雪/雷/霧）と時間帯（朝焼け/昼/夕焼け/夜）で
     背景のグラデーションを切り替えます。
   ・雨のアニメーションは canvas。画面が隠れているときは止めるので、
     バッテリーへの影響を最小限にしています。
   ========================================================================= */
(function (global) {
  'use strict';

  /* =====================================================================
     1. 空の色
     ===================================================================== */

  // [上, 中, 下, 文字色(on-sky), темная判定]
  const P = {
    clearDawn:  ['#f6a15c', '#f8c56f', '#fde8c8', 'dark'],
    clearDay:   ['#5db4ec', '#8fd0f5', '#d7eefc', 'dark'],
    clearDusk:  ['#e2673b', '#f0a05c', '#f8d7a8', 'dark'],
    clearNight: ['#0d1b33', '#1b3357', '#2c4a72', 'light'],

    cloudyDawn: ['#b08f80', '#d3b7a5', '#eddcd0', 'dark'],
    cloudyDay:  ['#8ba4bb', '#b3c6d6', '#dde8f0', 'dark'],
    cloudyDusk: ['#9d7b74', '#c39d90', '#e5cbbd', 'dark'],
    cloudyNight:['#161e29', '#232f3d', '#354456', 'light'],

    rainDay:    ['#54697b', '#75899a', '#a3b6c4', 'light'],
    rainDawn:   ['#6b6a76', '#8f8b93', '#bab5bb', 'light'],
    rainDusk:   ['#6a5b62', '#8e7a7c', '#b8a5a2', 'light'],
    rainNight:  ['#0d141c', '#1a2530', '#2b3846', 'light'],

    snowDay:    ['#8ba3b8', '#bcd0de', '#e6f1f8', 'dark'],
    snowNight:  ['#131c27', '#22303f', '#3a4b5c', 'light'],

    thunderDay: ['#3f4757', '#5b6478', '#8b93a5', 'light'],
    thunderNight:['#0b0f18', '#171d29', '#2a3141', 'light'],

    fogDay:     ['#9aa4ac', '#bcc4c9', '#e0e4e6', 'dark'],
    fogNight:   ['#161a1e', '#252b31', '#3a4147', 'light']
  };

  // ダークテーマのときに使う、暗めの対応表
  const DARK_MAP = {
    clearDawn: 'clearNight', clearDay: 'clearNight', clearDusk: 'clearNight',
    cloudyDawn: 'cloudyNight', cloudyDay: 'cloudyNight', cloudyDusk: 'cloudyNight',
    rainDay: 'rainNight', rainDawn: 'rainNight', rainDusk: 'rainNight',
    snowDay: 'snowNight', thunderDay: 'thunderNight', fogDay: 'fogNight'
  };

  /** 天気コード → 空のカテゴリ */
  function skyCategory(code) {
    const g = global.WeatherIcons.group(code);
    if (g === 'thunder' || g === 'thunderHail') return 'thunder';
    if (/snow|sleet/.test(g)) return 'snow';
    if (/rain|shower|drizzle/.test(g)) return 'rain';
    if (g === 'fog') return 'fog';
    if (g === 'clear' || g === 'mostlyClear') return 'clear';
    return 'cloudy';
  }

  /** 時間帯 → 'dawn' | 'day' | 'dusk' | 'night' */
  function timePhase(hour, sunriseH, sunsetH) {
    const sr = sunriseH == null ? 6 : sunriseH;
    const ss = sunsetH == null ? 18 : sunsetH;
    if (hour >= sr - 1 && hour < sr + 1.5) return 'dawn';
    if (hour >= ss - 1.5 && hour < ss + 1) return 'dusk';
    if (hour >= sr && hour < ss) return 'day';
    return 'night';
  }

  function pick(cat, phase) {
    const cap = phase.charAt(0).toUpperCase() + phase.slice(1);
    // 雪・雷・霧は朝焼け/夕焼けを持たないので昼夜だけ
    if (cat === 'snow' || cat === 'thunder' || cat === 'fog') {
      const key = cat + (phase === 'night' ? 'Night' : 'Day');
      return key;
    }
    const key = cat + cap;
    return P[key] ? key : cat + 'Day';
  }

  /** "5:18" → 5.3 */
  function hhmmToNum(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return +m[1] + (+m[2]) / 60;
  }

  let currentKey = null;

  /**
   * 空を更新する
   * @param {object} o {code, hour, sunrise:"5:18", sunset:"17:59", darkMode:boolean}
   */
  function apply(o) {
    const cat = skyCategory(o.code);
    const phase = timePhase(
      o.hour != null ? o.hour : 12,
      hhmmToNum(o.sunrise),
      hhmmToNum(o.sunset)
    );

    let key = pick(cat, phase);
    if (o.darkMode && DARK_MAP[key]) key = DARK_MAP[key];
    const pal = P[key] || P.cloudyDay;

    const root = document.documentElement;
    root.style.setProperty('--sky-1', pal[0]);
    root.style.setProperty('--sky-2', pal[1]);
    root.style.setProperty('--sky-3', pal[2]);
    root.setAttribute('data-on-sky', pal[3]);
    root.setAttribute('data-sky', cat);
    root.setAttribute('data-phase', phase);

    // 太陽・月の位置（晴れているときだけ見せる）
    const sun = document.getElementById('skySun');
    if (sun) {
      const show = (cat === 'clear' || cat === 'cloudy');
      sun.style.opacity = show ? '' : '0';
      const t = Math.max(0, Math.min(1, ((o.hour != null ? o.hour : 12) - 5) / 14));
      sun.style.left = (12 + t * 70) + '%';
      sun.style.top = (46 - Math.sin(t * Math.PI) * 34) + '%';
      sun.style.background = phase === 'night'
        ? 'radial-gradient(circle,rgba(255,240,200,.95),rgba(255,240,200,0) 68%)'
        : 'radial-gradient(circle,rgba(255,231,150,.95),rgba(255,214,120,0) 68%)';
    }

    // ブラウザのテーマカラー（スマホの上部バーの色）
    const meta = document.getElementById('meta-theme-color');
    if (meta) meta.setAttribute('content', pal[0]);

    currentKey = key;
    return { key, category: cat, phase, palette: pal };
  }

  /* =====================================================================
     2. 雨・雪のアニメーション（canvas）
     ===================================================================== */

  const Rain = {
    canvas: null, ctx: null, raf: 0,
    drops: [], mode: 'off', intensity: 0,
    w: 0, h: 0, dpr: 1, running: false
  };

  function reduceMotion() {
    return global.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function ensureCanvas() {
    if (Rain.canvas) return true;
    const c = document.getElementById('rainCanvas');
    if (!c) return false;
    Rain.canvas = c;
    Rain.ctx = c.getContext('2d');
    resize();
    global.addEventListener('resize', resize, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else if (Rain.mode !== 'off') start();
    });
    return true;
  }

  function resize() {
    if (!Rain.canvas) return;
    Rain.dpr = Math.min(2, global.devicePixelRatio || 1);
    Rain.w = Rain.canvas.clientWidth || global.innerWidth;
    Rain.h = Rain.canvas.clientHeight || global.innerHeight;
    Rain.canvas.width = Math.round(Rain.w * Rain.dpr);
    Rain.canvas.height = Math.round(Rain.h * Rain.dpr);
    Rain.ctx.setTransform(Rain.dpr, 0, 0, Rain.dpr, 0, 0);
    seed();
  }

  function seed() {
    const n = Rain.mode === 'off' ? 0 : dropCount();
    const arr = [];
    for (let i = 0; i < n; i++) arr.push(newDrop(true));
    Rain.drops = arr;
  }

  function dropCount() {
    if (Rain.mode === 'off') return 0;
    const area = Math.max(1, (Rain.w * Rain.h) / (390 * 780)); // iPhone基準
    const base = Rain.mode === 'snow' ? 42 : 60;
    const byIntensity = 0.55 + Rain.intensity * 0.75;   // intensity: 0〜1
    return Math.round(Math.min(120, base * area * byIntensity));
  }

  function newDrop(spread) {
    if (Rain.mode === 'snow') {
      return {
        x: Math.random() * (Rain.w + 40) - 20,
        y: spread ? Math.random() * Rain.h : -10,
        r: 1.3 + Math.random() * 2.2,
        vy: 18 + Math.random() * 26,
        drift: (Math.random() - 0.5) * 22,
        ph: Math.random() * Math.PI * 2,
        a: 0.45 + Math.random() * 0.45
      };
    }
    const speed = 420 + Math.random() * 420 + Rain.intensity * 260;
    return {
      x: Math.random() * (Rain.w + 120) - 60,
      y: spread ? Math.random() * Rain.h : -30,
      len: 9 + Math.random() * 14 + Rain.intensity * 10,
      vy: speed,
      vx: -speed * 0.16,
      a: 0.18 + Math.random() * 0.3
    };
  }

  let lastT = 0;
  function frame(t) {
    if (!Rain.running) return;
    const dt = Math.min(0.05, lastT ? (t - lastT) / 1000 : 0.016);
    lastT = t;
    const ctx = Rain.ctx;
    ctx.clearRect(0, 0, Rain.w, Rain.h);

    if (Rain.mode === 'snow') {
      ctx.fillStyle = '#ffffff';
      for (const d of Rain.drops) {
        d.ph += dt * 1.6;
        d.y += d.vy * dt;
        d.x += Math.sin(d.ph) * d.drift * dt;
        if (d.y > Rain.h + 8) Object.assign(d, newDrop(false));
        ctx.globalAlpha = d.a;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4;
      ctx.lineCap = 'round';
      for (const d of Rain.drops) {
        d.y += d.vy * dt;
        d.x += d.vx * dt;
        if (d.y > Rain.h + 20) Object.assign(d, newDrop(false));
        ctx.globalAlpha = d.a;
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x + d.vx * 0.028, d.y + d.len);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    Rain.raf = requestAnimationFrame(frame);
  }

  function start() {
    if (Rain.running || Rain.mode === 'off') return;
    if (document.hidden) return;
    Rain.running = true;
    lastT = 0;
    Rain.raf = requestAnimationFrame(frame);
  }

  function stop() {
    Rain.running = false;
    if (Rain.raf) cancelAnimationFrame(Rain.raf);
    Rain.raf = 0;
    if (Rain.ctx) Rain.ctx.clearRect(0, 0, Rain.w, Rain.h);
  }

  /**
   * 雨・雪の演出を設定する
   * @param {'off'|'rain'|'snow'} mode
   * @param {number} intensity 0〜1
   */
  function setPrecip(mode, intensity) {
    if (!ensureCanvas()) return;
    if (reduceMotion()) mode = 'off';
    Rain.intensity = Math.max(0, Math.min(1, intensity || 0));
    if (mode === Rain.mode) {
      // 強さだけ変わった場合は粒の数を調整
      if (mode !== 'off' && Rain.drops.length !== dropCount()) seed();
      return;
    }
    Rain.mode = mode;
    if (mode === 'off') { stop(); Rain.drops = []; Rain.canvas.style.opacity = '0'; return; }
    Rain.canvas.style.opacity = '';
    seed();
    start();
  }

  global.Sky = {
    apply,
    setPrecip,
    stopPrecip: stop,
    category: skyCategory,
    phase: timePhase,
    get currentKey() { return currentKey; }
  };

})(window);
