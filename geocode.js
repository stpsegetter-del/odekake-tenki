/* =========================================================================
   geocode.js  —  場所を探す
   ---------------------------------------------------------------------
   1. 国土地理院 住所検索API（町・丁目レベルまで / 日本全国 / 施設名もOK）
   2. 見つからないときは Open-Meteo の地名検索（駅名や海外向けの保険）
   3. 現在地(GPS) → 国土地理院 逆ジオコーダ → 住所名
   いずれも登録不要・無料・APIキー不要です。
   ========================================================================= */
(function (global) {
  'use strict';

  const GSI_SEARCH = 'https://msearch.gsi.go.jp/address-search/AddressSearch';
  const GSI_REVERSE = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';
  const OM_GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';

  const TIMEOUT_MS = 8000;
  const MAX_RESULTS = 12;

  /** カスタムヘッダを付けない = CORSプリフライトを発生させない（重要） */
  function fetchJson(url, timeoutMs) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, timeoutMs || TIMEOUT_MS);
    const opts = { method: 'GET', mode: 'cors', cache: 'no-store' };
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(url, opts)
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .finally(() => clearTimeout(timer));
  }

  /* ---------------- 住所検索（国土地理院） ---------------- */

  function searchGsi(query) {
    const url = GSI_SEARCH + '?q=' + encodeURIComponent(query);
    return fetchJson(url).then((json) => {
      if (!Array.isArray(json)) return [];
      const out = [];
      for (const item of json) {
        const g = item && item.geometry;
        const p = item && item.properties;
        if (!g || !Array.isArray(g.coordinates) || !p) continue;
        const lon = Number(g.coordinates[0]);
        const lat = Number(g.coordinates[1]);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        // 日本の範囲から大きく外れるものは弾く
        if (lat < 20 || lat > 46 || lon < 122 || lon > 154) continue;
        out.push({
          title: String(p.title || '').trim(),
          lat, lon,
          // dataSource が付くのは施設（区役所・駅など）
          kind: p.dataSource ? 'facility' : 'address',
          source: 'gsi'
        });
      }
      return out;
    });
  }

  /* ---------------- 地名検索（Open-Meteo / 保険） ---------------- */

  function searchOpenMeteo(query) {
    const url = OM_GEOCODE + '?name=' + encodeURIComponent(query) +
                '&count=8&language=ja&format=json';
    return fetchJson(url).then((json) => {
      const rows = (json && json.results) || [];
      return rows.map((r) => {
        const parts = [];
        if (r.country_code !== 'JP' && r.country) parts.push(r.country);
        if (r.admin1) parts.push(r.admin1);
        if (r.admin2 && r.admin2 !== r.admin1) parts.push(r.admin2);
        if (r.name && parts[parts.length - 1] !== r.name) parts.push(r.name);
        return {
          title: parts.join('') || String(r.name || ''),
          lat: Number(r.latitude),
          lon: Number(r.longitude),
          kind: 'place',
          source: 'openmeteo'
        };
      }).filter((r) => isFinite(r.lat) && isFinite(r.lon) && r.title);
    });
  }

  /* ---------------- 併用検索 ---------------- */

  /**
   * 場所を検索する。国土地理院を主、Open-Meteo を保険として使う。
   * @returns {Promise<Array<{title,lat,lon,kind,source}>>}
   */
  function search(query) {
    const q = String(query || '').trim();
    if (q.length < 1) return Promise.resolve([]);

    return searchGsi(q)
      .catch(() => [])
      .then((gsi) => {
        // 国土地理院で十分に見つかったらそれで確定
        if (gsi.length >= 3) return dedupe(gsi).slice(0, MAX_RESULTS);
        // 少ないときだけ Open-Meteo を足す（駅名・海外・カタカナ地名など）
        return searchOpenMeteo(q)
          .catch(() => [])
          .then((om) => dedupe(gsi.concat(om)).slice(0, MAX_RESULTS));
      });
  }

  function dedupe(list) {
    const seen = new Set();
    const out = [];
    for (const r of list) {
      // タイトルが同じ、または座標がほぼ同じものは1つにまとめる
      const keyTitle = r.title;
      const keyGeo = r.lat.toFixed(3) + ',' + r.lon.toFixed(3);
      if (seen.has(keyTitle) || seen.has(keyGeo)) continue;
      seen.add(keyTitle);
      seen.add(keyGeo);
      out.push(r);
    }
    return out;
  }

  /* ---------------- 現在地 ---------------- */

  /** navigator.geolocation を Promise 化 */
  function currentPosition(opts) {
    const o = Object.assign({ timeout: 12000, maximumAge: 5 * 60 * 1000, enableHighAccuracy: true }, opts || {});
    return new Promise((resolve, reject) => {
      if (!global.navigator || !navigator.geolocation) {
        reject(new GeoError('unsupported', 'この端末では現在地を取得できません'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        }),
        (err) => {
          let code = 'unknown';
          let msg = '現在地を取得できませんでした';
          if (err && err.code === 1) { code = 'denied'; msg = '位置情報の利用が許可されていません'; }
          else if (err && err.code === 2) { code = 'unavailable'; msg = '現在地がわかりませんでした'; }
          else if (err && err.code === 3) { code = 'timeout'; msg = '現在地の取得に時間がかかっています'; }
          reject(new GeoError(code, msg));
        },
        o
      );
    });
  }

  function GeoError(code, message) {
    this.name = 'GeoError';
    this.code = code;
    this.message = message;
  }
  GeoError.prototype = Object.create(Error.prototype);

  /**
   * 座標 → 住所名（国土地理院 逆ジオコーダ）
   * 失敗しても致命的ではないので、取れなければ緯度経度を返す。
   */
  function reverse(lat, lon) {
    const url = GSI_REVERSE + '?lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lon);
    return fetchJson(url, 6000).then((json) => {
      const r = json && json.results;
      if (!r) return fallbackName(lat, lon);
      const muni = (global.MuniTable && global.MuniTable.nameOf(r.muniCd)) || '';
      const town = r.lv01Nm && r.lv01Nm !== '－' ? r.lv01Nm : '';
      const full = (muni + town).trim();
      return {
        address: full || fallbackName(lat, lon).address,
        muni: muni,
        town: town,
        // タブ用の短い名前の候補
        shortName: town || shortenMuni(muni) || '現在地'
      };
    }).catch(() => fallbackName(lat, lon));
  }

  function fallbackName(lat, lon) {
    return {
      address: `北緯${lat.toFixed(3)}° 東経${lon.toFixed(3)}°`,
      muni: '', town: '', shortName: '現在地'
    };
  }

  /** 「東京都渋谷区」→「渋谷区」のように、タブ用に短くする */
  function shortenMuni(muni) {
    if (!muni) return '';
    const m = muni.match(/(?:都|道|府|県)(.+)$/);
    let s = m ? m[1] : muni;
    // 「札幌市中央区」→「中央区」
    const m2 = s.match(/^.+?市(.+区)$/);
    if (m2) s = m2[1];
    return s;
  }

  /** 検索結果のタイトルから、名前の初期値をつくる（タブに収まる短さに） */
  function suggestName(title) {
    if (!title) return '';
    let s = shortenMuni(title);
    // 丁目まで入っていたら丁目を落として短く
    s = s.replace(/([一二三四五六七八九十百]+丁目|\d+丁目)$/, '');
    // まだ長いときは「大阪市北区梅田」→「梅田」のように町名だけにする
    if (s.length > 6) {
      const m = s.match(/^.*[市区町村](.+)$/);
      if (m && m[1].length >= 2) s = m[1];
    }
    return s.slice(0, 12) || title.slice(0, 12);
  }

  global.Geocode = {
    search,
    searchGsi,
    searchOpenMeteo,
    currentPosition,
    reverse,
    suggestName,
    shortenMuni,
    GeoError
  };

})(window);
