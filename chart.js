/* =========================================================================
   chart.js  —  時間別グラフ（SVGを自前で描画）
   ---------------------------------------------------------------------
   ・棒＝選んだ項目（降水確率／風／湿度）、折れ線＝気温。
   ・「出かける時間帯」は帯で強調します。
   ・列をタップすると詳細を開けます（キーボードでも選べます）。
   ========================================================================= */
(function (global) {
  'use strict';

  const VB_W = 360;

  // 縦のレイアウト（viewBox 単位）
  const L = {
    iconTop: 3,
    iconSize: 24,
    tempLabelBase: 45,
    lineTop: 52,
    lineBottom: 118,
    barTop: 124,
    barBase: 176,
    barLabelBase: 190,
    hourLabelBase: 205,
    height: 210
  };

  const METRICS = {
    rain:     { key: 'pop',      unit: '%',    max: 100, color: 'var(--ch-rain,#3d8fd6)',  name: '降水確率' },
    humidity: { key: 'humidity', unit: '%',    max: 100, color: 'var(--ch-humid,#4bb3a5)', name: '湿度' },
    wind:     { key: 'wind',     unit: 'm/s',  max: null, color: 'var(--ch-wind,#7f8fa6)', name: '風速' },
    feels:    { key: 'pop',      unit: '%',    max: 100, color: 'var(--ch-rain,#3d8fd6)',  name: '降水確率', faded: true }
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function r2(n) { return Math.round(n * 100) / 100; }

  /* ---------------------------------------------------------------
     複数時間をひとまとめにする（明日のグラフ用：3時間ごとなど）
     --------------------------------------------------------------- */
  function aggregate(hours, size) {
    if (!size || size <= 1) return hours.slice();
    const out = [];
    for (let i = 0; i < hours.length; i += size) {
      const block = hours.slice(i, i + size);
      if (!block.length) continue;
      const head = block[0];
      const mid = block[Math.floor(block.length / 2)];
      let pop = null, precip = 0, wind = null, hum = 0, humN = 0;
      let worst = head;
      for (const h of block) {
        // 雨は「見落とさない」ことが大事なので最大値、
        // 気温は「その時間帯らしさ」が大事なので真ん中の値を使う。
        if (h.pop != null) pop = pop == null ? h.pop : Math.max(pop, h.pop);
        if (h.precip != null) precip += h.precip;
        if (h.wind != null) wind = wind == null ? h.wind : Math.max(wind, h.wind);
        if (h.humidity != null) { hum += h.humidity; humN++; }
        if (severity(h.code) > severity(worst.code)) worst = h;
      }
      const temp = mid.temp != null ? mid.temp : head.temp;
      const feels = mid.feels != null ? mid.feels : head.feels;
      out.push({
        key: head.key, date: head.date, hour: head.hour,
        span: block.length,
        temp, feels,
        humidity: humN ? Math.round(hum / humN) : null,
        pop, precip: Math.round(precip * 10) / 10,
        wind, code: worst.code, isDay: block[Math.floor(block.length / 2)].isDay
      });
    }
    return out;
  }

  /** 「どちらの天気が目立つか」の順位（まとめるときの代表を選ぶ） */
  const SEVERITY_ORDER = ['clear', 'mostlyClear', 'partlyCloudy', 'cloudy', 'fog', 'drizzle',
    'snowLight', 'rainLight', 'showersLight', 'showers', 'rain', 'snow', 'sleet',
    'showersHeavy', 'rainHeavy', 'snowShowers', 'snowHeavy', 'thunder', 'thunderHail'];

  function severity(code) {
    const i = SEVERITY_ORDER.indexOf(global.WeatherIcons.group(code));
    return i < 0 ? 3 : i;
  }

  /* ---------------------------------------------------------------
     描画
     --------------------------------------------------------------- */

  /**
   * @param {HTMLElement} host  描画先
   * @param {object} opt
   *   hours: 時間の配列
   *   metric: 'rain'|'feels'|'wind'|'humidity'
   *   schedule: 出かける時間帯の設定（帯の強調に使用）
   *   markNow: 先頭を「今」と表示するか
   *   onSelect: (hour, index) => void
   */
  function render(host, opt) {
    const o = Object.assign({ metric: 'rain', markNow: false, schedule: null }, opt || {});
    const hours = o.hours || [];
    if (!host) return;
    if (!hours.length) {
      host.innerHTML = '<p class="chart-empty">データがありません</p>';
      return;
    }

    const n = hours.length;
    const colW = VB_W / n;
    const m = METRICS[o.metric] || METRICS.rain;

    /* --- 棒のスケール --- */
    let barMax = m.max;
    if (barMax == null) {
      let mx = 0;
      for (const h of hours) if (h[m.key] != null) mx = Math.max(mx, h[m.key]);
      barMax = Math.max(6, Math.ceil(mx / 2) * 2);
    }

    /* --- 気温のスケール --- */
    const temps = [];
    for (const h of hours) {
      if (h.temp != null) temps.push(h.temp);
      if (o.metric === 'feels' && h.feels != null) temps.push(h.feels);
    }
    let tMin = temps.length ? Math.min.apply(null, temps) : 0;
    let tMax = temps.length ? Math.max.apply(null, temps) : 1;
    if (tMax - tMin < 4) { const c = (tMax + tMin) / 2; tMin = c - 2; tMax = c + 2; }
    const pad = (tMax - tMin) * 0.18;
    tMin -= pad; tMax += pad;
    const tY = (v) => L.lineBottom - ((v - tMin) / (tMax - tMin)) * (L.lineBottom - L.lineTop);

    const cx = (i) => colW * i + colW / 2;

    let svg = '';

    /* --- 出かける時間帯の帯 --- */
    if (o.schedule) {
      let spanStart = -1;
      for (let i = 0; i <= n; i++) {
        const inRange = i < n && global.Advice.inSchedule(hours[i], o.schedule);
        if (inRange && spanStart < 0) spanStart = i;
        if (!inRange && spanStart >= 0) {
          const x = colW * spanStart;
          const w = colW * (i - spanStart);
          svg += `<rect class="ch-band" x="${r2(x)}" y="1" width="${r2(w)}" height="${L.barBase - 1}" rx="6"/>`;
          spanStart = -1;
        }
      }
    }

    /* --- 日付の変わり目 --- */
    for (let i = 1; i < n; i++) {
      if (hours[i].date !== hours[i - 1].date) {
        const x = colW * i;
        svg += `<line class="ch-daysep" x1="${r2(x)}" y1="2" x2="${r2(x)}" y2="${L.barBase}"/>`;
        svg += `<text class="ch-daylabel" x="${r2(x + 3)}" y="${L.iconTop + 8}">翌日</text>`;
      }
    }

    /* --- 棒グラフの基準線 --- */
    svg += `<line class="ch-baseline" x1="0" y1="${L.barBase}" x2="${VB_W}" y2="${L.barBase}"/>`;

    /* --- 棒 --- */
    const barW = Math.max(5, Math.min(18, colW * 0.5));
    for (let i = 0; i < n; i++) {
      const v = hours[i][m.key];
      if (v == null) continue;
      const ratio = Math.max(0, Math.min(1, v / barMax));
      const h = ratio * (L.barBase - L.barTop);
      const x = cx(i) - barW / 2;
      const y = L.barBase - h;
      if (h >= 0.8) {
        const rx = Math.min(barW / 2, 3);
        svg += `<rect class="ch-bar${m.faded ? ' is-faded' : ''}" x="${r2(x)}" y="${r2(y)}" ` +
               `width="${r2(barW)}" height="${r2(h)}" rx="${rx}" style="fill:${m.color}"/>`;
      } else {
        svg += `<rect class="ch-bar is-zero" x="${r2(x)}" y="${L.barBase - 1.5}" ` +
               `width="${r2(barW)}" height="1.5" rx="0.75"/>`;
      }
    }

    /* --- 気温の折れ線 --- */
    svg += line(hours, 'temp', cx, tY, 'ch-line ch-line--temp');
    if (o.metric === 'feels') {
      svg += line(hours, 'feels', cx, tY, 'ch-line ch-line--feels');
    }

    /* --- 気温の点と数値 --- */
    for (let i = 0; i < n; i++) {
      const h = hours[i];
      if (h.temp == null) continue;
      const y = tY(h.temp);
      svg += `<circle class="ch-dot" cx="${r2(cx(i))}" cy="${r2(y)}" r="2.4"/>`;
      svg += `<text class="ch-temp-label" x="${r2(cx(i))}" y="${r2(Math.max(L.tempLabelBase, y - 7))}">${Math.round(h.temp)}</text>`;
    }
    if (o.metric === 'feels') {
      for (let i = 0; i < n; i++) {
        const h = hours[i];
        if (h.feels == null) continue;
        svg += `<circle class="ch-dot ch-dot--feels" cx="${r2(cx(i))}" cy="${r2(tY(h.feels))}" r="2"/>`;
      }
    }

    /* --- 天気アイコン --- */
    for (let i = 0; i < n; i++) {
      const h = hours[i];
      const s = Math.min(L.iconSize, colW * 0.86);
      const x = cx(i) - s / 2;
      svg += `<g transform="translate(${r2(x)} ${L.iconTop}) scale(${r2(s / 64)})" class="ch-icon">` +
             global.WeatherIcons.svg(h.code, h.isDay, { size: 64, cls: '' })
               .replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '') +
             `</g>`;
    }

    /* --- 棒の数値 --- */
    for (let i = 0; i < n; i++) {
      const v = hours[i][m.key];
      if (v == null) continue;
      const txt = m.key === 'wind' ? String(Math.round(v * 10) / 10) : String(Math.round(v));
      const zero = Math.round(v) === 0;
      const style = zero ? '' : ` style="fill:${m.color}"`;
      svg += `<text class="ch-bar-label${zero ? ' is-zero' : ''}" x="${r2(cx(i))}" y="${L.barLabelBase}"${style}>${esc(txt)}</text>`;
    }

    /* --- 時刻 --- */
    for (let i = 0; i < n; i++) {
      const h = hours[i];
      const isNow = o.markNow && i === 0;
      const label = isNow ? '今' : String(h.hour);
      svg += `<text class="ch-hour${isNow ? ' is-now' : ''}" x="${r2(cx(i))}" y="${L.hourLabelBase}">${esc(label)}</text>`;
    }

    /* --- タップ領域 --- */
    for (let i = 0; i < n; i++) {
      const h = hours[i];
      svg += `<rect class="ch-hit" data-i="${i}" x="${r2(colW * i)}" y="0" width="${r2(colW)}" ` +
             `height="${L.height}" tabindex="0" role="button" aria-label="${esc(hitLabel(h, o))}"/>`;
    }

    host.innerHTML =
      `<svg class="chart" viewBox="0 0 ${VB_W} ${L.height}" width="100%" ` +
      `preserveAspectRatio="xMidYMid meet" role="group" aria-label="${esc(o.ariaLabel || '時間別の予報')}">` +
      svg + `</svg>`;

    /* --- 操作 --- */
    if (typeof o.onSelect === 'function') {
      const svgEl = host.firstChild;
      svgEl.addEventListener('click', (ev) => {
        const t = ev.target.closest ? ev.target.closest('.ch-hit') : null;
        if (!t) return;
        const i = Number(t.getAttribute('data-i'));
        if (isFinite(i) && hours[i]) o.onSelect(hours[i], i);
      });
      svgEl.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        const t = ev.target.closest ? ev.target.closest('.ch-hit') : null;
        if (!t) return;
        ev.preventDefault();
        const i = Number(t.getAttribute('data-i'));
        if (isFinite(i) && hours[i]) o.onSelect(hours[i], i);
      });
    }
  }

  function hitLabel(h, o) {
    const parts = [`${h.hour}時`, global.WeatherIcons.label(h.code)];
    if (h.temp != null) parts.push(`${Math.round(h.temp)}度`);
    if (h.pop != null) parts.push(`降水確率${Math.round(h.pop)}パーセント`);
    return parts.join(' ');
  }

  function line(hours, key, cx, tY, cls) {
    const pts = [];
    for (let i = 0; i < hours.length; i++) {
      const v = hours[i][key];
      if (v == null) { continue; }
      pts.push([cx(i), tY(v)]);
    }
    if (pts.length < 2) return '';
    return `<path class="${cls}" d="${smoothPath(pts)}" fill="none"/>`;
  }

  /** なめらかな折れ線（カトマル・ロム風） */
  function smoothPath(pts) {
    if (pts.length < 2) return '';
    let d = `M${r2(pts[0][0])} ${r2(pts[0][1])}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const t = 0.2;
      const c1x = p1[0] + (p2[0] - p0[0]) * t;
      const c1y = p1[1] + (p2[1] - p0[1]) * t;
      const c2x = p2[0] - (p3[0] - p1[0]) * t;
      const c2y = p2[1] - (p3[1] - p1[1]) * t;
      d += `C${r2(c1x)} ${r2(c1y)},${r2(c2x)} ${r2(c2y)},${r2(p2[0])} ${r2(p2[1])}`;
    }
    return d;
  }

  global.Chart = { render, aggregate, METRICS };

})(window);
