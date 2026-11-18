/* =========================================================================
   weather.js  —  予報データの取得とキャッシュ
   ---------------------------------------------------------------------
   配信元を2つ持っています。1つが止まってもアプリが使えるようにするためです。

   【主】Open-Meteo（日本国内は気象庁モデルが自動採用される）
        1時間ごと・降水確率あり・軽い（約9KB）
        ※ models=jma_seamless と明示すると降水確率が返らないので指定しない

   【副】met.no（ノルウェー気象研究所）
        1時間ごと・体感温度あり。ただし日本では降水確率が提供されないため、
        こちらに切り替わったときは「降水量(mm)」で表示します。

   主がだめなら1回やり直し、それでもだめなら副に切り替えます。
   ========================================================================= */
(function (global) {
  'use strict';

  const OM_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
  const MET_ENDPOINT = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';

  const OM_HOURLY = [
    'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
    'precipitation_probability', 'precipitation', 'weather_code',
    'wind_speed_10m', 'is_day'
  ];
  const OM_DAILY = [
    'weather_code', 'temperature_2m_max', 'temperature_2m_min',
    'precipitation_probability_max', 'precipitation_sum', 'sunrise', 'sunset'
  ];
  const OM_CURRENT = [
    'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
    'weather_code', 'wind_speed_10m', 'is_day'
  ];

  const FRESH_MS = 10 * 60 * 1000;
  const USABLE_MS = 12 * 60 * 60 * 1000;
  const TIMEOUT_MS = 14000;
  const RETRY_WAIT_MS = 1200;

  const SOURCES = {
    'open-meteo': { label: 'Open-Meteo（国内は気象庁モデル）', hasPop: true },
    'met-no': { label: 'met.no（ノルウェー気象研究所）', hasPop: false }
  };

  /* ---------------- 共通 ---------------- */

  function WeatherError(code, message) {
    this.name = 'WeatherError';
    this.code = code;
    this.message = message;
  }
  WeatherError.prototype = Object.create(Error.prototype);

  function fetchJson(url, timeoutMs) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, timeoutMs || TIMEOUT_MS);
    const opts = { method: 'GET', mode: 'cors' };
    if (ctrl) opts.signal = ctrl.signal;

    return fetch(url, opts)
      .then((res) => {
        if (!res.ok) throw new WeatherError('http', 'HTTP ' + res.status);
        return res.json();
      })
      .catch((err) => {
        if (err instanceof WeatherError) throw err;
        if (err && err.name === 'AbortError') throw new WeatherError('timeout', 'timeout');
        throw new WeatherError('offline', 'network');
      })
      .finally(() => clearTimeout(timer));
  }

  function num(v) {
    const n = Number(v);
    return isFinite(n) ? n : null;
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- 主：Open-Meteo ---------------- */

  function omUrl(place) {
    return OM_ENDPOINT + '?' + [
      'latitude=' + encodeURIComponent(place.lat),
      'longitude=' + encodeURIComponent(place.lon),
      'hourly=' + OM_HOURLY.join(','),
      'daily=' + OM_DAILY.join(','),
      'current=' + OM_CURRENT.join(','),
      'timezone=auto',
      'wind_speed_unit=ms',
      'forecast_days=6'
    ].join('&');
  }

  /** "2026-09-08T14:00" → 部品 */
  function parseLocalStr(str) {
    const m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    return {
      key: m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4],
      date: m[1] + '-' + m[2] + '-' + m[3],
      hour: +m[4], min: +m[5]
    };
  }

  function normalizeOpenMeteo(json) {
    if (json && json.error) throw new WeatherError('api', String(json.reason || 'api error'));
    const h = json.hourly || {};
    const d = json.daily || {};
    const c = json.current || {};
    const times = h.time || [];

    const hourly = [];
    for (let i = 0; i < times.length; i++) {
      const t = parseLocalStr(times[i]);
      if (!t) continue;
      hourly.push({
        key: t.key, date: t.date, hour: t.hour,
        temp: num(h.temperature_2m && h.temperature_2m[i]),
        feels: num(h.apparent_temperature && h.apparent_temperature[i]),
        humidity: num(h.relative_humidity_2m && h.relative_humidity_2m[i]),
        pop: num(h.precipitation_probability && h.precipitation_probability[i]),
        precip: num(h.precipitation && h.precipitation[i]),
        code: num(h.weather_code && h.weather_code[i]),
        wind: num(h.wind_speed_10m && h.wind_speed_10m[i]),
        isDay: (h.is_day && h.is_day[i]) ? 1 : 0
      });
    }

    const daily = [];
    const dTimes = d.time || [];
    for (let i = 0; i < dTimes.length; i++) {
      const sr = parseLocalStr(d.sunrise && d.sunrise[i]);
      const ss = parseLocalStr(d.sunset && d.sunset[i]);
      daily.push({
        date: String(dTimes[i]),
        code: num(d.weather_code && d.weather_code[i]),
        tmax: num(d.temperature_2m_max && d.temperature_2m_max[i]),
        tmin: num(d.temperature_2m_min && d.temperature_2m_min[i]),
        popMax: num(d.precipitation_probability_max && d.precipitation_probability_max[i]),
        precipSum: num(d.precipitation_sum && d.precipitation_sum[i]),
        sunrise: sr ? sr.hour + ':' + String(sr.min).padStart(2, '0') : null,
        sunset: ss ? ss.hour + ':' + String(ss.min).padStart(2, '0') : null
      });
    }

    const ct = parseLocalStr(c.time);
    const current = ct ? {
      key: ct.key, date: ct.date, hour: ct.hour, minute: ct.min,
      temp: num(c.temperature_2m), feels: num(c.apparent_temperature),
      humidity: num(c.relative_humidity_2m), code: num(c.weather_code),
      wind: num(c.wind_speed_10m), isDay: c.is_day ? 1 : 0
    } : null;

    return {
      source: 'open-meteo',
      hasPop: true,
      timezone: String(json.timezone || 'Asia/Tokyo'),
      utcOffsetSeconds: num(json.utc_offset_seconds) || 0,
      elevation: num(json.elevation),
      current, hourly, daily
    };
  }

  /* ---------------- 副：met.no ---------------- */

  function metUrl(place) {
    // 小数4桁まで（met.no の利用規約で、座標は丸めることが求められている）
    const lat = Math.round(place.lat * 10000) / 10000;
    const lon = Math.round(place.lon * 10000) / 10000;
    return MET_ENDPOINT + '?lat=' + lat + '&lon=' + lon;
  }

  /** met.no の symbol_code → 気象庁/WMO 風の天気コード */
  const MET_SYMBOLS = {
    clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3,
    fog: 45,
    lightrainshowers: 80, rainshowers: 80, heavyrainshowers: 82,
    lightrain: 61, rain: 63, heavyrain: 65,
    lightsleet: 66, sleet: 66, heavysleet: 67,
    lightsleetshowers: 66, sleetshowers: 66, heavysleetshowers: 67,
    lightsnow: 71, snow: 73, heavysnow: 75,
    lightsnowshowers: 85, snowshowers: 85, heavysnowshowers: 86,
    lightrainandthunder: 95, rainandthunder: 95, heavyrainandthunder: 96,
    lightrainshowersandthunder: 95, rainshowersandthunder: 95,
    heavyrainshowersandthunder: 96,
    lightsnowandthunder: 95, snowandthunder: 95, heavysnowandthunder: 96,
    lightsleetandthunder: 95, sleetandthunder: 95, heavysleetandthunder: 96
  };

  function metCode(symbol) {
    if (!symbol) return null;
    const base = String(symbol).replace(/_(day|night|polartwilight)$/, '');
    const code = MET_SYMBOLS[base];
    return code == null ? 3 : code;
  }

  function metIsDay(symbol, hour) {
    if (symbol && /_night$/.test(symbol)) return 0;
    if (symbol && /_day$/.test(symbol)) return 1;
    return (hour >= 6 && hour < 18) ? 1 : 0;
  }

  /** Date → その端末の現地時間での部品 */
  function localParts(dt) {
    const y = dt.getFullYear();
    const mo = String(dt.getMonth() + 1).padStart(2, '0');
    const da = String(dt.getDate()).padStart(2, '0');
    const hh = String(dt.getHours()).padStart(2, '0');
    return {
      key: `${y}-${mo}-${da}T${hh}`,
      date: `${y}-${mo}-${da}`,
      hour: dt.getHours(),
      min: dt.getMinutes()
    };
  }

  function normalizeMetNo(json) {
    const series = (json && json.properties && json.properties.timeseries) || [];
    if (!series.length) throw new WeatherError('api', 'no data');

    const hourly = [];
    for (const row of series) {
      const dt = new Date(row.time);
      if (isNaN(dt)) continue;
      const inst = (row.data && row.data.instant && row.data.instant.details) || {};
      const n1 = row.data && row.data.next_1_hours;
      // 1時間ごとの情報があるところまでを使う（その先は6時間ごとになる）
      if (!n1) continue;
      const p = localParts(dt);
      const symbol = n1.summary && n1.summary.symbol_code;
      hourly.push({
        key: p.key, date: p.date, hour: p.hour,
        temp: num(inst.air_temperature),
        feels: num(inst.apparent_air_temperature != null
          ? inst.apparent_air_temperature : inst.air_temperature),
        humidity: num(inst.relative_humidity),
        pop: null,                                   // 日本では提供されない
        precip: num(n1.details && n1.details.precipitation_amount),
        code: metCode(symbol),
        wind: num(inst.wind_speed),
        isDay: metIsDay(symbol, p.hour)
      });
    }
    if (!hourly.length) throw new WeatherError('api', 'no hourly');

    /* 日別は、1時間ごとが途切れたあと（約60時間以降）の
       6時間ごとのコマも使って組み立てる。そうしないと5日間予報が埋まらない。 */
    const byDate = {};
    for (const row of series) {
      const dt = new Date(row.time);
      if (isNaN(dt)) continue;
      const p = localParts(dt);
      const inst = (row.data && row.data.instant && row.data.instant.details) || {};
      const block = (row.data && (row.data.next_1_hours || row.data.next_6_hours)) || null;
      const temp = num(inst.air_temperature);
      const code = metCode(block && block.summary && block.summary.symbol_code);
      const mm = num(block && block.details && block.details.precipitation_amount);

      const d = byDate[p.date] || (byDate[p.date] = {
        date: p.date, tmax: null, tmin: null, precipSum: 0, code: null
      });
      if (temp != null) {
        d.tmax = d.tmax == null ? temp : Math.max(d.tmax, temp);
        d.tmin = d.tmin == null ? temp : Math.min(d.tmin, temp);
      }
      if (mm != null) d.precipSum += mm;
      // 昼間のコマを優先しつつ、目立つ天気を代表にする
      if (code != null && (d.code == null || severity(code) > severity(d.code))) d.code = code;
    }

    const daily = Object.keys(byDate).sort().slice(0, 6).map((k) => {
      const d = byDate[k];
      return {
        date: d.date,
        code: d.code == null ? 3 : d.code,
        tmax: d.tmax, tmin: d.tmin,
        popMax: null,
        precipSum: Math.round(d.precipSum * 10) / 10,
        sunrise: null, sunset: null
      };
    });

    const first = hourly[0];
    const current = {
      key: first.key, date: first.date, hour: first.hour, minute: 0,
      temp: first.temp, feels: first.feels, humidity: first.humidity,
      code: first.code, wind: first.wind, isDay: first.isDay
    };

    return {
      source: 'met-no',
      hasPop: false,
      timezone: 'local',
      utcOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      elevation: null,
      current, hourly, daily
    };
  }

  /** 天気の「目立ちやすさ」。日別の代表を選ぶのに使う */
  const SEVERITY = [0, 1, 2, 3, 45, 51, 61, 80, 63, 71, 73, 66, 82, 65, 85, 75, 86, 95, 96];
  function severity(code) {
    const i = SEVERITY.indexOf(code);
    return i < 0 ? 3 : i;
  }

  /* ---------------- 時刻ユーティリティ ---------------- */

  function localNow(data) {
    if (data && data.current && data.current.key) return data.current;
    const off = (data && data.utcOffsetSeconds) || 0;
    const t = new Date(Date.now() + off * 1000);
    const y = t.getUTCFullYear();
    const mo = String(t.getUTCMonth() + 1).padStart(2, '0');
    const d = String(t.getUTCDate()).padStart(2, '0');
    const hh = String(t.getUTCHours()).padStart(2, '0');
    return { key: `${y}-${mo}-${d}T${hh}`, date: `${y}-${mo}-${d}`, hour: t.getUTCHours(), minute: t.getUTCMinutes() };
  }

  function nowIndex(data) {
    const now = localNow(data);
    const i = data.hourly.findIndex((x) => x.key === now.key);
    if (i >= 0) return i;
    const j = data.hourly.findIndex((x) => x.key > now.key);
    return j >= 0 ? j : 0;
  }

  function nextHours(data, count) {
    return data.hourly.slice(nowIndex(data), nowIndex(data) + count);
  }

  function hoursOfDate(data, dateStr, fromHour, toHour) {
    const from = fromHour == null ? 0 : fromHour;
    const to = toHour == null ? 23 : toHour;
    return data.hourly.filter((x) => x.date === dateStr && x.hour >= from && x.hour <= to);
  }

  function todayStr(data) { return localNow(data).date; }

  function dateAfter(dateStr, n) {
    const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return dateStr;
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
  }

  function weekdayOf(dateStr) {
    const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return 0;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  }

  /* ---------------- 取得の流れ ---------------- */

  /**
   * 主 → （少し待って）主をもう一度 → 副 の順に試す。
   * どれで取れたかは data.source に入ります。
   */
  function fetchWithFallback(place, report) {
    const say = (s) => { if (typeof report === 'function') report(s); };

    return fetchJson(omUrl(place)).then(normalizeOpenMeteo)
      .catch((e1) => {
        say('retry');
        return wait(RETRY_WAIT_MS)
          .then(() => fetchJson(omUrl(place), 10000))
          .then(normalizeOpenMeteo)
          .catch((e2) => {
            say('fallback');
            return fetchJson(metUrl(place), 15000).then(normalizeMetNo)
              .catch(() => {
                // どちらもだめ。最初の失敗の種類で文言を変える
                const code = (e2 && e2.code) || (e1 && e1.code) || 'offline';
                throw new WeatherError(
                  code === 'offline' ? 'offline' : 'providers',
                  code === 'offline'
                    ? 'インターネットに接続できませんでした'
                    : '天気データの配信元が応答していません'
                );
              });
          });
      });
  }

  /* ---------------- 本体 ---------------- */

  const Weather = {
    Error: WeatherError,
    SOURCES,

    cached(placeId) {
      const c = global.Store && Store.getCache(placeId);
      if (!c) return null;
      const age = Date.now() - c.fetchedAt;
      if (age > USABLE_MS) return null;
      return { data: c.data, fetchedAt: c.fetchedAt, age, fresh: age < FRESH_MS };
    },

    fetch(place, report) {
      return fetchWithFallback(place, report).then((data) => {
        if (global.Store) Store.setCache(place.id, data);
        return { data, fetchedAt: Date.now(), age: 0, fresh: true };
      });
    },

    load(place, opts) {
      const o = opts || {};
      const c = Weather.cached(place.id);
      if (c && c.fresh && !o.force) return Promise.resolve(c);
      return Weather.fetch(place).catch((err) => {
        if (c) { c.error = err; return c; }
        throw err;
      });
    },

    /** どこまでつながるかを調べる（設定の「通信テスト」用） */
    diagnose() {
      const probe = (name, url) => {
        const t0 = Date.now();
        return fetchJson(url, 8000)
          .then(() => ({ name, ok: true, ms: Date.now() - t0 }))
          .catch((e) => ({ name, ok: false, ms: Date.now() - t0, code: e.code }));
      };
      return Promise.all([
        probe('予報（主）', OM_ENDPOINT + '?latitude=35&longitude=139&hourly=temperature_2m&forecast_days=1'),
        probe('予報（副）', MET_ENDPOINT + '?lat=35&lon=139'),
        probe('雨雲レーダー', 'https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json'),
        probe('地名検索', 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent('東京'))
      ]);
    },

    localNow, nowIndex, nextHours, hoursOfDate, todayStr, dateAfter, weekdayOf,
    FRESH_MS, USABLE_MS
  };

  global.Weather = Weather;

})(window);
