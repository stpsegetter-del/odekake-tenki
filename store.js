/* =========================================================================
   store.js  —  設定と地点の保存（この端末の中だけ / localStorage）
   ---------------------------------------------------------------------
   ・localStorage が使えない環境（プライベートモード等）でも落ちないよう
     メモリ上のフォールバックを持ちます。
   ========================================================================= */
(function (global) {
  'use strict';

  const NS = 'odekake:v1:';
  const K_PLACES = NS + 'places';
  const K_SETTINGS = NS + 'settings';
  const K_CACHE = NS + 'cache:';

  /* ---------- localStorage ラッパ ---------- */
  const memory = new Map();
  let hasLS = (function () {
    try {
      const k = NS + '__t';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  })();

  function readRaw(key) {
    if (hasLS) {
      try { return localStorage.getItem(key); } catch (e) { hasLS = false; }
    }
    return memory.has(key) ? memory.get(key) : null;
  }

  function writeRaw(key, value) {
    memory.set(key, value);
    if (!hasLS) return false;
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      // 容量オーバーのときは古いキャッシュを捨ててもう一度だけ試す
      try {
        pruneCaches();
        localStorage.setItem(key, value);
        return true;
      } catch (e2) { return false; }
    }
  }

  function removeRaw(key) {
    memory.delete(key);
    if (!hasLS) return;
    try { localStorage.removeItem(key); } catch (e) { /* noop */ }
  }

  function readJson(key, fallback) {
    const raw = readRaw(key);
    if (!raw) return fallback;
    try {
      const v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function writeJson(key, value) { return writeRaw(key, JSON.stringify(value)); }

  /** 予報キャッシュだけを消す（設定と地点は残す） */
  function pruneCaches() {
    if (!hasLS) return;
    const doomed = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(K_CACHE) === 0) doomed.push(k);
    }
    doomed.forEach((k) => { try { localStorage.removeItem(k); } catch (e) {} });
  }

  /* ---------- 既定の設定 ---------- */
  const DEFAULT_SETTINGS = {
    activePlaceId: null,
    tempPref: 'normal',              // 'cold' | 'normal' | 'hot'
    schedule: {
      weekday: { enabled: true, start: 8, end: 19 },
      holiday: { enabled: false, start: 10, end: 18 }
    },
    theme: 'auto',                   // 'auto' | 'light' | 'dark'
    rainAnim: true
  };

  function normalizeSettings(s) {
    const d = DEFAULT_SETTINGS;
    const out = {
      activePlaceId: s && s.activePlaceId != null ? String(s.activePlaceId) : null,
      tempPref: ['cold', 'normal', 'hot'].indexOf(s && s.tempPref) >= 0 ? s.tempPref : d.tempPref,
      theme: ['auto', 'light', 'dark'].indexOf(s && s.theme) >= 0 ? s.theme : d.theme,
      rainAnim: s && typeof s.rainAnim === 'boolean' ? s.rainAnim : d.rainAnim,
      schedule: {
        weekday: normRange(s && s.schedule && s.schedule.weekday, d.schedule.weekday),
        holiday: normRange(s && s.schedule && s.schedule.holiday, d.schedule.holiday)
      }
    };
    return out;
  }

  function normRange(r, def) {
    const start = clampHour(r && r.start, def.start);
    let end = clampHour(r && r.end, def.end);
    if (end <= start) end = Math.min(23, start + 1);
    return {
      enabled: r && typeof r.enabled === 'boolean' ? r.enabled : def.enabled,
      start, end
    };
  }

  function clampHour(v, def) {
    const n = Number(v);
    if (!isFinite(n)) return def;
    return Math.max(0, Math.min(23, Math.round(n)));
  }

  /* ---------- 地点 ---------- */
  function normalizePlace(p) {
    if (!p || !isFinite(Number(p.lat)) || !isFinite(Number(p.lon))) return null;
    return {
      id: String(p.id || genId()),
      name: String(p.name || '場所').slice(0, 12),
      address: String(p.address || ''),
      lat: round4(Number(p.lat)),
      lon: round4(Number(p.lon))
    };
  }

  function round4(n) { return Math.round(n * 10000) / 10000; }

  function genId() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  const Store = {
    /* --- 地点 --- */
    getPlaces() {
      const arr = readJson(K_PLACES, []);
      if (!Array.isArray(arr)) return [];
      return arr.map(normalizePlace).filter(Boolean);
    },

    setPlaces(list) {
      const clean = (Array.isArray(list) ? list : []).map(normalizePlace).filter(Boolean);
      writeJson(K_PLACES, clean);
      return clean;
    },

    addPlace(place) {
      const p = normalizePlace(Object.assign({ id: genId() }, place));
      if (!p) return null;
      const list = Store.getPlaces();
      list.push(p);
      Store.setPlaces(list);
      return p;
    },

    updatePlace(id, patch) {
      const list = Store.getPlaces();
      const i = list.findIndex((p) => p.id === id);
      if (i < 0) return null;
      list[i] = normalizePlace(Object.assign({}, list[i], patch, { id }));
      Store.setPlaces(list);
      return list[i];
    },

    removePlace(id) {
      const list = Store.getPlaces().filter((p) => p.id !== id);
      Store.setPlaces(list);
      removeRaw(K_CACHE + id);
      return list;
    },

    /** 地点の並びを1つ動かす（dir: -1 上へ / +1 下へ） */
    movePlace(id, dir) {
      const list = Store.getPlaces();
      const i = list.findIndex((p) => p.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return list;
      const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
      return Store.setPlaces(list);
    },

    findPlace(id) {
      return Store.getPlaces().find((p) => p.id === id) || null;
    },

    /** 既に同じ座標の地点が登録されていないか */
    findPlaceNear(lat, lon) {
      const t = 0.002; // だいたい200m
      return Store.getPlaces().find(
        (p) => Math.abs(p.lat - lat) < t && Math.abs(p.lon - lon) < t) || null;
    },

    /* --- 設定 --- */
    getSettings() {
      return normalizeSettings(readJson(K_SETTINGS, {}));
    },

    saveSettings(patch) {
      const next = normalizeSettings(Object.assign({}, Store.getSettings(), patch));
      writeJson(K_SETTINGS, next);
      return next;
    },

    /* --- 予報キャッシュ --- */
    getCache(placeId) {
      const c = readJson(K_CACHE + placeId, null);
      if (!c || !c.fetchedAt || !c.data) return null;
      return c;
    },

    setCache(placeId, data) {
      writeJson(K_CACHE + placeId, { fetchedAt: Date.now(), data });
    },

    clearCaches: pruneCaches,

    get storageAvailable() { return hasLS; }
  };

  global.Store = Store;

})(window);
