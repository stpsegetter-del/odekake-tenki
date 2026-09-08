/* =========================================================================
   weather.js  —  予報データの取得とキャッシュ（Open-Meteo）
   ---------------------------------------------------------------------
   ・APIキー不要・完全無料。
   ・モデルは指定しません。Open-Meteo が地域ごとに最適なモデルを選び、
     日本国内では気象庁(JMA)のモデルが採用されます。
     （models=jma_seamless と明示すると降水確率が返らないため指定しない）
   ・時刻はすべて「その地点の現地時間」の文字列として扱い、端末のタイム
     ゾーンには依存させません。
   ========================================================================= */
(function (global) {
  'use strict';

  const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

  const HOURLY = [
    'temperature_2m',
    'apparent_temperature',
    'relative_humidity_2m',
    'precipitation_probability',
    'precipitation',
    'weather_code',
    'wind_speed_10m',
    'is_day'
  ];

  const DAILY = [
    'weather_code',
    'temperature_2m_max',
    'temperature_2m_min',
    'precipitation_probability_max',
    'precipitation_sum',
    'sunrise',
    'sunset'
  ];

  const CURRENT = [
    'temperature_2m',
    'apparent_temperature',
    'relative_humidity_2m',
    'weather_code',
    'wind_speed_10m',
    'is_day'
  ];

  const FRESH_MS = 10 * 60 * 1000;        // 10分以内なら「最新」とみなす
  const USABLE_MS = 12 * 60 * 60 * 1000;  // 12時間を超えたキャッシュは使わない
  const TIMEOUT_MS = 12000;

  /* ---------------- ネットワーク ---------------- */

  function buildUrl(place) {
    const p = [
      'latitude=' + encodeURIComponent(place.lat),
      'longitude=' + encodeURIComponent(place.lon),
      'hourly=' + HOURLY.join(','),
      'daily=' + DAILY.join(','),
      'current=' + CURRENT.join(','),
      'timezone=auto',
      'wind_speed_unit=ms',
      // 6日分あれば「これから12時間」「明日」「5日間予報」をすべて賄えます。
      // past_hours を足すと hourly が16日分に膨らむので付けません（実測 20.9KB→8.9KB）。
      'forecast_days=6'
    ];
    return ENDPOINT + '?' + p.join('&');
  }

  function fetchRaw(place) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    const opts = { method: 'GET', mode: 'cors', cache: 'no-store' };
    if (ctrl) opts.signal = ctrl.signal;

    return fetch(buildUrl(place), opts)
      .then((res) => {
        if (!res.ok) throw new WeatherError('http', '予報を取れませんでした（' + res.status + '）');
        return res.json();
      })
      .then((json) => {
        if (json && json.error) throw new WeatherError('api', String(json.reason || '予報を取れませんでした'));
        return normalize(json);
      })
      .catch((err) => {
        if (err instanceof WeatherError) throw err;
        if (err && err.name === 'AbortError') {
          throw new WeatherError('timeout', '通信に時間がかかっています');
        }
        throw new WeatherError('offline', 'インターネットに接続できませんでした');
      })
      .finally(() => clearTimeout(timer));
  }

  function WeatherError(code, message) {
    this.name = 'WeatherError';
    this.code = code;
    this.message = message;
  }
  WeatherError.prototype = Object.create(Error.prototype);

  /* ---------------- 正規化 ---------------- */

  /** "2026-09-08T14:00" → {key:"2026-09-08T14", date:"2026-09-08", hour:14} */
  function parseLocal(str) {
    const s = String(str || '');
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    return {
      key: m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4],
      date: m[1] + '-' + m[2] + '-' + m[3],
      y: +m[1], mo: +m[2], d: +m[3], hour: +m[4], min: +m[5],
      raw: s
    };
  }

  function num(v) {
    const n = Number(v);
    return isFinite(n) ? n : null;
  }

  function normalize(json) {
    const h = json.hourly || {};
    const d = json.daily || {};
    const c = json.current || {};
    const times = h.time || [];

    const hourly = [];
    for (let i = 0; i < times.length; i++) {
      const t = parseLocal(times[i]);
      if (!t) continue;
      hourly.push({
        key: t.key,
        date: t.date,
        hour: t.hour,
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
      const sr = parseLocal(d.sunrise && d.sunrise[i]);
      const ss = parseLocal(d.sunset && d.sunset[i]);
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

    const ct = parseLocal(c.time);
    const current = ct ? {
      key: ct.key,
      date: ct.date,
      hour: ct.hour,
      minute: ct.min,
      temp: num(c.temperature_2m),
      feels: num(c.apparent_temperature),
      humidity: num(c.relative_humidity_2m),
      code: num(c.weather_code),
      wind: num(c.wind_speed_10m),
      isDay: c.is_day ? 1 : 0
    } : null;

    return {
      timezone: String(json.timezone || 'Asia/Tokyo'),
      utcOffsetSeconds: num(json.utc_offset_seconds) || 0,
      elevation: num(json.elevation),
      current, hourly, daily
    };
  }

  /* ---------------- 時刻ユーティリティ ---------------- */

  /** その地点の「今」を {key,date,hour,minute} で返す */
  function localNow(data) {
    if (data && data.current && data.current.key) return data.current;
    // current が無い場合は端末時刻＋UTCオフセットから算出
    const off = (data && data.utcOffsetSeconds) || 0;
    const t = new Date(Date.now() + off * 1000);
    const y = t.getUTCFullYear();
    const mo = String(t.getUTCMonth() + 1).padStart(2, '0');
    const d = String(t.getUTCDate()).padStart(2, '0');
    const hh = String(t.getUTCHours()).padStart(2, '0');
    return {
      key: `${y}-${mo}-${d}T${hh}`,
      date: `${y}-${mo}-${d}`,
      hour: t.getUTCHours(),
      minute: t.getUTCMinutes()
    };
  }

  /** 「今の時間」に対応する hourly のインデックス */
  function nowIndex(data) {
    const now = localNow(data);
    const i = data.hourly.findIndex((x) => x.key === now.key);
    if (i >= 0) return i;
    // 見つからなければ、今より後の最初の時間
    const j = data.hourly.findIndex((x) => x.key > now.key);
    return j >= 0 ? j : 0;
  }

  /** 今から count 時間分を切り出す */
  function nextHours(data, count) {
    const i = nowIndex(data);
    return data.hourly.slice(i, i + count);
  }

  /** 指定日の指定時間帯（両端を含む）を切り出す */
  function hoursOfDate(data, dateStr, fromHour, toHour) {
    const from = fromHour == null ? 0 : fromHour;
    const to = toHour == null ? 23 : toHour;
    return data.hourly.filter((x) => x.date === dateStr && x.hour >= from && x.hour <= to);
  }

  /** 今日の日付文字列（その地点の現地日付） */
  function todayStr(data) { return localNow(data).date; }

  /** n日後の日付文字列 */
  function dateAfter(dateStr, n) {
    const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return dateStr;
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
  }

  /** 日付文字列 → 曜日（0=日） */
  function weekdayOf(dateStr) {
    const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return 0;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  }

  /* ---------------- キャッシュつき読み込み ---------------- */

  const Weather = {
    Error: WeatherError,

    /** キャッシュを取り出す（古すぎるものは null） */
    cached(placeId) {
      const c = global.Store && Store.getCache(placeId);
      if (!c) return null;
      const age = Date.now() - c.fetchedAt;
      if (age > USABLE_MS) return null;
      return { data: c.data, fetchedAt: c.fetchedAt, age, fresh: age < FRESH_MS };
    },

    /** ネットワークから取得してキャッシュに保存 */
    fetch(place) {
      return fetchRaw(place).then((data) => {
        if (global.Store) Store.setCache(place.id, data);
        return { data, fetchedAt: Date.now(), age: 0, fresh: true };
      });
    },

    /** キャッシュが新しければそれを返し、古ければ取りに行く */
    load(place, opts) {
      const o = opts || {};
      const c = Weather.cached(place.id);
      if (c && c.fresh && !o.force) return Promise.resolve(c);
      return Weather.fetch(place).catch((err) => {
        if (c) { c.error = err; return c; }
        throw err;
      });
    },

    localNow, nowIndex, nextHours, hoursOfDate, todayStr, dateAfter, weekdayOf,
    FRESH_MS, USABLE_MS
  };

  global.Weather = Weather;

})(window);
