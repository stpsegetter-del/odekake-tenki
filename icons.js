/* =========================================================================
   icons.js  —  おでかけ天気 オリジナルSVGアイコン
   ---------------------------------------------------------------------
   ・天気アイコンはすべて 64x64 の viewBox で自作。端末に依存しません。
   ・色は CSS 変数で指定しているので、ライト/ダークで自動的に馴染みます。
   ========================================================================= */
(function (global) {
  'use strict';

  let uidSeq = 0;
  const uid = (p) => `${p}-${(++uidSeq).toString(36)}`;

  /* ---------- 色（CSS変数 + フォールバック） ---------- */
  const C = {
    sun: 'var(--ic-sun,#FFC53D)',
    sunEdge: 'var(--ic-sun-edge,#FFAE1A)',
    moon: 'var(--ic-moon,#FFE9AE)',
    cloud: 'var(--ic-cloud,#FFFFFF)',
    cloudShade: 'var(--ic-cloud-shade,#D8E4F0)',
    cloudDark: 'var(--ic-cloud-dark,#A9B9CB)',
    rain: 'var(--ic-rain,#3D97DE)',
    snow: 'var(--ic-snow,#9FD6FF)',
    bolt: 'var(--ic-bolt,#FFB020)',
    fog: 'var(--ic-fog,#C2D2E2)'
  };

  /* ---------- 基本パーツ ---------- */

  // 太陽（光線つき）
  function sun(cx, cy, r) {
    const rays = [];
    const inner = r + r * 0.42;
    const outer = r + r * 0.92;
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI / 4) * i - Math.PI / 2;
      const x1 = cx + Math.cos(a) * inner, y1 = cy + Math.sin(a) * inner;
      const x2 = cx + Math.cos(a) * outer, y2 = cy + Math.sin(a) * outer;
      rays.push(`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`);
    }
    return `<g stroke="${C.sunEdge}" stroke-width="${f(r * 0.32)}" stroke-linecap="round">${rays.join('')}</g>` +
           `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.sun}"/>`;
  }

  // 太陽（光線なし・雲の後ろ用）
  function sunPlain(cx, cy, r) {
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.sun}"/>`;
  }

  // 月（三日月・マスクで欠けを作る）
  function moon(cx, cy, r) {
    const id = uid('mn');
    return `<mask id="${id}">` +
             `<rect x="0" y="0" width="64" height="64" fill="#fff"/>` +
             `<circle cx="${f(cx - r * 0.52)}" cy="${f(cy - r * 0.42)}" r="${f(r * 0.92)}" fill="#000"/>` +
           `</mask>` +
           `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.moon}" mask="url(#${id})"/>`;
  }

  // 星（夜の演出）
  function star(cx, cy, s) {
    return `<path d="M${cx} ${cy - s}L${f(cx + s * 0.28)} ${f(cy - s * 0.28)}L${cx + s} ${cy}` +
           `L${f(cx + s * 0.28)} ${f(cy + s * 0.28)}L${cx} ${cy + s}L${f(cx - s * 0.28)} ${f(cy + s * 0.28)}` +
           `L${cx - s} ${cy}L${f(cx - s * 0.28)} ${f(cy - s * 0.28)}Z" fill="${C.moon}" opacity=".85"/>`;
  }

  /**
   * 雲。tx/ty/scale で位置と大きさを調整。
   * 基準形は x:13〜56 / 下端 y:48。
   */
  function cloud(opts) {
    const o = Object.assign({ tx: 0, ty: 0, s: 1, fill: C.cloud, shade: true }, opts || {});
    const body =
      `<circle cx="24" cy="36" r="11"/>` +
      `<circle cx="37" cy="32" r="13"/>` +
      `<circle cx="47" cy="39" r="9"/>` +
      `<rect x="13" y="38" width="43" height="10" rx="5"/>`;
    const shade = o.shade
      ? `<path d="M13 43h43v0a5 5 0 0 1-5 5H18a5 5 0 0 1-5-5Z" fill="${C.cloudShade}" opacity=".55"/>`
      : '';
    return `<g transform="translate(${f(o.tx)} ${f(o.ty)}) scale(${f(o.s)})">` +
             `<g fill="${o.fill}">${body}</g>${shade}` +
           `</g>`;
  }

  // 雨粒（斜めの短い線）
  function rainDrops(count, y, opts) {
    const o = Object.assign({ len: 9, gap: 12, x0: 20, w: 3.4, color: C.rain, op: 1 }, opts || {});
    let s = '';
    for (let i = 0; i < count; i++) {
      const x = o.x0 + i * o.gap;
      s += `<line x1="${f(x + o.len * 0.34)}" y1="${y}" x2="${f(x - o.len * 0.2)}" y2="${f(y + o.len)}"/>`;
    }
    return `<g stroke="${o.color}" stroke-width="${o.w}" stroke-linecap="round" opacity="${o.op}">${s}</g>`;
  }

  // 雪（6本線の結晶）
  function snowFlakes(count, y, opts) {
    const o = Object.assign({ r: 4.2, gap: 13, x0: 20, color: C.snow }, opts || {});
    let s = '';
    for (let i = 0; i < count; i++) {
      const cx = o.x0 + i * o.gap;
      const cy = y + (i % 2 === 1 ? 3 : 0);
      for (let k = 0; k < 3; k++) {
        const a = (Math.PI / 3) * k;
        s += `<line x1="${f(cx - Math.cos(a) * o.r)}" y1="${f(cy - Math.sin(a) * o.r)}" ` +
             `x2="${f(cx + Math.cos(a) * o.r)}" y2="${f(cy + Math.sin(a) * o.r)}"/>`;
      }
    }
    return `<g stroke="${o.color}" stroke-width="2.4" stroke-linecap="round">${s}</g>`;
  }

  // 雷
  function bolt(cx, y) {
    return `<path d="M${cx + 2} ${y}l-9 13h6l-4 12 12-16h-7l6-9Z" fill="${C.bolt}"/>`;
  }

  // 霧（横線）
  function fogLines(y) {
    return `<g stroke="${C.fog}" stroke-width="3.6" stroke-linecap="round">` +
           `<line x1="12" y1="${y}" x2="48" y2="${y}"/>` +
           `<line x1="18" y1="${y + 9}" x2="54" y2="${y + 9}"/>` +
           `<line x1="14" y1="${y + 18}" x2="44" y2="${y + 18}"/>` +
           `</g>`;
  }

  function f(n) { return Math.round(n * 100) / 100; }

  /* ---------- 天気コード → グループ ---------- */
  const GROUPS = {
    0: 'clear', 1: 'mostlyClear', 2: 'partlyCloudy', 3: 'cloudy',
    45: 'fog', 48: 'fog',
    51: 'drizzle', 53: 'drizzle', 55: 'drizzle', 56: 'drizzle', 57: 'drizzle',
    61: 'rainLight', 63: 'rain', 65: 'rainHeavy',
    66: 'sleet', 67: 'sleet',
    71: 'snowLight', 73: 'snow', 75: 'snowHeavy', 77: 'snow',
    80: 'showersLight', 81: 'showers', 82: 'showersHeavy',
    85: 'snowShowers', 86: 'snowShowers',
    95: 'thunder', 96: 'thunderHail', 99: 'thunderHail'
  };

  /* ---------- 天気コード → 日本語 ---------- */
  const LABELS = {
    0: '快晴', 1: '晴れ', 2: '晴れ時々くもり', 3: 'くもり',
    45: '霧', 48: '霧（着氷）',
    51: '弱い霧雨', 53: '霧雨', 55: '強い霧雨', 56: '凍る霧雨', 57: '強い凍る霧雨',
    61: '弱い雨', 63: '雨', 65: '強い雨',
    66: 'みぞれ', 67: '強いみぞれ',
    71: '弱い雪', 73: '雪', 75: '大雪', 77: '霧雪',
    80: 'にわか雨', 81: 'にわか雨', 82: '激しいにわか雨',
    85: 'にわか雪', 86: '強いにわか雪',
    95: '雷雨', 96: '雷雨（ひょう）', 99: '激しい雷雨（ひょう）'
  };

  // グラフの上など、狭い場所で使う短い表記
  const SHORT_LABELS = {
    clear: '快晴', mostlyClear: '晴れ', partlyCloudy: '晴れ/曇', cloudy: 'くもり',
    fog: '霧', drizzle: '霧雨', rainLight: '弱い雨', rain: '雨', rainHeavy: '強い雨',
    sleet: 'みぞれ', snowLight: '弱い雪', snow: '雪', snowHeavy: '大雪',
    showersLight: 'にわか雨', showers: 'にわか雨', showersHeavy: '強い雨',
    snowShowers: 'にわか雪', thunder: '雷雨', thunderHail: '雷雨'
  };

  function groupOf(code) { return GROUPS[code] || 'cloudy'; }
  function labelOf(code) { return LABELS[code] != null ? LABELS[code] : 'くもり'; }
  function shortLabelOf(code) { return SHORT_LABELS[groupOf(code)] || 'くもり'; }

  /** 雨・雪が「降っている」天気かどうか */
  function isWet(code) {
    const g = groupOf(code);
    return /drizzle|rain|shower|snow|sleet|thunder/i.test(g);
  }
  /** 雪系かどうか */
  function isSnowy(code) {
    return /snow|sleet/i.test(groupOf(code));
  }

  /* ---------- 天気アイコン本体 ---------- */
  function build(code, isDay) {
    const g = groupOf(code);
    const day = isDay !== 0 && isDay !== false;
    const lum = day ? sun : moon;      // 単独で出す発光体
    const lumPlain = day ? sunPlain : moon;  // 雲の後ろに出す発光体

    // 小さめの雲（発光体と組み合わせるとき）
    const smallCloud = (extra) => cloud(Object.assign({ tx: 4, ty: 6, s: 0.82 }, extra));

    switch (g) {
      case 'clear':
        return day
          ? lum(32, 30, 13)
          : moon(34, 30, 14) + star(15, 16, 3.2) + star(52, 44, 2.6) + star(48, 15, 2);

      case 'mostlyClear':
        return lumPlain(24, 24, 11) + smallCloud();

      case 'partlyCloudy':
        return lumPlain(23, 22, 10) + cloud({ tx: 2, ty: 4, s: 0.9 });

      case 'cloudy':
        return cloud({ tx: -3, ty: -6, s: 0.72, fill: C.cloudShade, shade: false }) +
               cloud({ tx: 2, ty: 3, s: 0.9 });

      case 'fog':
        return cloud({ tx: 2, ty: -6, s: 0.82 }) + fogLines(46);

      case 'drizzle':
        return lumPlain(22, 20, 9) + smallCloud({ ty: 2 }) +
               rainDrops(3, 46, { len: 6, gap: 12, x0: 22, w: 2.8, op: 0.9 });

      case 'rainLight':
        return cloud({ tx: 2, ty: -4, s: 0.9 }) + rainDrops(3, 46, { len: 7, gap: 13, x0: 21, w: 3 });

      case 'rain':
        return cloud({ tx: 2, ty: -6, s: 0.9 }) + rainDrops(4, 44, { len: 9, gap: 11, x0: 18 });

      case 'rainHeavy':
        return cloud({ tx: 2, ty: -7, s: 0.92, fill: C.cloud }) +
               rainDrops(4, 42, { len: 12, gap: 11, x0: 18, w: 3.8 }) +
               rainDrops(3, 48, { len: 10, gap: 11, x0: 24, w: 3.2, op: 0.65 });

      case 'showersLight':
      case 'showers':
        return lumPlain(21, 19, 9) + smallCloud({ ty: 0 }) +
               rainDrops(3, 46, { len: 8, gap: 12, x0: 22 });

      case 'showersHeavy':
        return lumPlain(20, 18, 8) + smallCloud({ ty: 0 }) +
               rainDrops(3, 44, { len: 11, gap: 12, x0: 22, w: 3.8 }) +
               rainDrops(2, 50, { len: 8, gap: 12, x0: 28, w: 3, op: 0.6 });

      case 'sleet':
        return cloud({ tx: 2, ty: -6, s: 0.9 }) +
               rainDrops(2, 45, { len: 8, gap: 22, x0: 20 }) +
               snowFlakes(2, 49, { x0: 32, gap: 13, r: 3.6 });

      case 'snowLight':
        return cloud({ tx: 2, ty: -4, s: 0.9 }) + snowFlakes(2, 48, { x0: 26, gap: 14 });

      case 'snow':
      case 'snowShowers':
        return cloud({ tx: 2, ty: -6, s: 0.9 }) + snowFlakes(3, 47, { x0: 20, gap: 13 });

      case 'snowHeavy':
        return cloud({ tx: 2, ty: -7, s: 0.92 }) +
               snowFlakes(3, 45, { x0: 19, gap: 13, r: 4.6 }) +
               snowFlakes(2, 54, { x0: 26, gap: 13, r: 3.4 });

      case 'thunder':
        return cloud({ tx: 2, ty: -7, s: 0.9, fill: C.cloud }) + bolt(28, 42);

      case 'thunderHail':
        return cloud({ tx: 2, ty: -8, s: 0.9 }) + bolt(26, 40) +
               rainDrops(2, 46, { len: 7, gap: 16, x0: 38, w: 3 });

      default:
        return cloud({ tx: 2, ty: 3, s: 0.9 });
    }
  }

  /**
   * 天気アイコンの SVG 文字列を返す
   * @param {number} code  WMO weather code
   * @param {boolean|number} isDay  昼なら true/1
   * @param {object} opt  { size, cls, title }
   */
  function weatherSvg(code, isDay, opt) {
    const o = Object.assign({ size: 48, cls: '', title: null }, opt || {});
    const label = o.title === null ? labelOf(code) : o.title;
    const titleTag = label ? `<title>${escapeHtml(label)}</title>` : '';
    return `<svg class="wi ${o.cls}" viewBox="0 0 64 64" width="${o.size}" height="${o.size}" ` +
           `role="img" aria-label="${escapeHtml(label || '天気')}" focusable="false">` +
           titleTag + build(code, isDay) + `</svg>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* =======================================================================
     アプリ用アイコン（傘・服装・警告など）
     ======================================================================= */

  const UI = {
    /** 傘。state: 'need' | 'folding' | 'no' */
    umbrella(state, size) {
      size = size || 40;
      const closed = state === 'no';
      const canopy = closed
        // 閉じた傘（斜め）
        ? `<path d="M40 12c-2 8-6 16-12 22l-9 9-4-4 9-9c6-6 12-10 16-18Z" fill="var(--ic-umb,#5B8DEF)"/>` +
          `<path d="M15 39l-4 8 8-4Z" fill="var(--ic-umb-dark,#3E6FD1)"/>`
        // 開いた傘
        : `<path d="M32 10c12 0 21 9 22 20a2 2 0 0 1-3 1.6c-2.6-2-5-3-7.2-3s-4.6 1-7.2 3a2 2 0 0 1-2.4 0` +
          `c-2.6-2-5-3-7.2-3s-4.6 1-7.2 3A2 2 0 0 1 10 30C11 19 20 10 32 10Z" fill="var(--ic-umb,#5B8DEF)"/>`;
      const handle = closed ? '' :
        `<path d="M32 30v16a5 5 0 0 1-10 0" stroke="var(--ic-umb-dark,#3E6FD1)" stroke-width="4" ` +
        `stroke-linecap="round" fill="none"/>`;
      const drops = state === 'need'
        ? `<g stroke="var(--ic-rain,#3D97DE)" stroke-width="3" stroke-linecap="round" opacity=".9">` +
          `<line x1="14" y1="40" x2="12" y2="47"/><line x1="52" y1="40" x2="50" y2="47"/></g>`
        : '';
      return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false">${canopy}${handle}${drops}</svg>`;
    },

    /** 服装。level: 0(暑い)〜4(かなり寒い) */
    clothing(level, size) {
      size = size || 40;
      const col = 'var(--ic-cloth,#6C8CA8)';
      const acc = 'var(--ic-cloth-acc,#E8A33D)';
      if (level <= 0) {
        // 半袖
        return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
          `<path d="M24 14h16l10 6-4 10-6-2v22H24V28l-6 2-4-10Z" fill="${col}"/></svg>`;
      }
      if (level === 1) {
        // 長袖シャツ
        return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
          `<path d="M24 14h16l10 6v20h-6v10H20V40h-6V20Z" fill="${col}"/>` +
          `<path d="M28 14h8l-4 8Z" fill="var(--ic-cloth-dark,#4E6B85)"/></svg>`;
      }
      if (level === 2) {
        // 薄手の上着（パーカー）
        return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
          `<path d="M23 15h18l10 7v20h-7v11H20V42h-7V22Z" fill="${col}"/>` +
          `<path d="M26 15h12a6 6 0 0 1-12 0Z" fill="${acc}"/>` +
          `<line x1="32" y1="22" x2="32" y2="53" stroke="var(--ic-cloth-dark,#4E6B85)" stroke-width="2.4"/></svg>`;
      }
      if (level === 3) {
        // コート
        return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
          `<path d="M23 13h18l11 8v22h-7v14H19V43h-7V21Z" fill="${col}"/>` +
          `<path d="M32 13l-6 5 6 6 6-6Z" fill="var(--ic-cloth-dark,#4E6B85)"/>` +
          `<line x1="32" y1="24" x2="32" y2="57" stroke="var(--ic-cloth-dark,#4E6B85)" stroke-width="2.6"/>` +
          `<circle cx="36" cy="33" r="1.8" fill="${acc}"/><circle cx="36" cy="42" r="1.8" fill="${acc}"/></svg>`;
      }
      // かなり寒い：コート＋マフラー
      return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
        `<path d="M23 13h18l11 8v22h-7v14H19V43h-7V21Z" fill="${col}"/>` +
        `<path d="M20 20h24v7a4 4 0 0 1-4 4H24a4 4 0 0 1-4-4Z" fill="${acc}"/>` +
        `<path d="M38 31h6v13l-6-3Z" fill="var(--ic-cloth-acc2,#D08A24)"/>` +
        `<line x1="32" y1="33" x2="32" y2="57" stroke="var(--ic-cloth-dark,#4E6B85)" stroke-width="2.6"/></svg>`;
    },

    /** 警告（雨アラート用の傘＋雨） */
    alertRain(size) {
      size = size || 44;
      return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
        cloud({ tx: 2, ty: -10, s: 0.86 }) +
        rainDrops(4, 40, { len: 12, gap: 11, x0: 18, w: 4 }) + `</svg>`;
    },

    alertSnow(size) {
      size = size || 44;
      return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
        cloud({ tx: 2, ty: -10, s: 0.86 }) +
        snowFlakes(3, 44, { x0: 20, gap: 13, r: 4.4 }) + `</svg>`;
    },

    /** アプリのロゴ（オンボーディング用） */
    logo(size) {
      size = size || 96;
      return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
        sunPlain(23, 21, 11) + cloud({ tx: 2, ty: 2, s: 0.88 }) +
        rainDrops(3, 50, { len: 7, gap: 13, x0: 21, w: 3 }) + `</svg>`;
    }
  };

  global.WeatherIcons = {
    svg: weatherSvg,
    label: labelOf,
    shortLabel: shortLabelOf,
    group: groupOf,
    isWet, isSnowy,
    ui: UI
  };

})(window);
