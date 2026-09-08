/* =========================================================================
   advice.js  —  「傘は要る？」「上着は要る？」の判定
   ---------------------------------------------------------------------
   ・傘の基準は「安全重視」。降水確率30%で傘をおすすめします。
     （持って行って降らなかった、より、持たずに濡れた、を避ける考え方）
   ・出かける時間帯が設定されているときは、その時間だけを見て判定します。
     寝ている間の雨で「傘を持って」と言われないようにするためです。
   ========================================================================= */
(function (global) {
  'use strict';

  /* ---------------- しきい値 ---------------- */
  const POP_UMBRELLA = 30;   // これ以上で傘をすすめる
  const POP_STRONG = 60;     // これ以上ならしっかりした傘
  const POP_LIGHT = 10;      // これ以上なら「折りたたみがあると安心」
  const POP_ALERT = 50;      // 画面上部に大きな警告を出す基準
  const MM_WET = 0.3;        // これ以上降ればその時間は「雨」とみなす
  const MM_STRONG = 3.0;     // 合計がこれ以上なら本降り
  const MM_ALERT = 1.0;      // 警告を出す合計降水量

  /* ---------------- 服装の基準（体感温度） ---------------- */
  // level: 0=半袖 1=長袖 2=薄手の上着 3=コート 4=厚手のコート
  const CLOTHING = [
    { min: 26, level: 0, title: '半袖でだいじょうぶ', note: '暑いので涼しい服装で。' },
    { min: 21, level: 1, title: '長袖1枚でちょうどいい', note: '上着はなくても平気そうです。' },
    { min: 16, level: 2, title: '薄手の上着があると安心', note: 'カーディガンやパーカーがちょうどいい気温です。' },
    { min: 8, level: 3, title: 'しっかりした上着を', note: 'コートやジャケットがほしい寒さです。' },
    { min: -99, level: 4, title: '厚手のコートを', note: 'マフラーや手袋もあると安心です。' }
  ];

  const PREF_SHIFT = { cold: -3, normal: 0, hot: 3 };

  /* ---------------- 時間帯の絞り込み ---------------- */

  /**
   * 「出かける時間帯」で絞り込む。
   * 該当が1つも無いときは絞り込まずに全部返す（判断材料をなくさないため）。
   */
  function applySchedule(hours, schedule) {
    if (!schedule) return { hours, applied: false };
    const picked = hours.filter((h) => {
      const wd = global.Weather.weekdayOf(h.date);
      const cfg = (wd === 0 || wd === 6) ? schedule.holiday : schedule.weekday;
      if (!cfg || !cfg.enabled) return false;
      return h.hour >= cfg.start && h.hour <= cfg.end;
    });
    if (picked.length === 0) return { hours, applied: false };
    return { hours: picked, applied: true };
  }

  /** ある時間が「出かける時間帯」に入っているか */
  function inSchedule(h, schedule) {
    if (!schedule) return false;
    const wd = global.Weather.weekdayOf(h.date);
    const cfg = (wd === 0 || wd === 6) ? schedule.holiday : schedule.weekday;
    if (!cfg || !cfg.enabled) return false;
    return h.hour >= cfg.start && h.hour <= cfg.end;
  }

  /* ---------------- 雨のまとまりを見つける ---------------- */

  /** 雨が降る時間の連続したかたまりを返す */
  function rainSpans(hours, popMin, mmMin) {
    const spans = [];
    let cur = null;
    for (const h of hours) {
      const wet = (h.pop != null && h.pop >= popMin) || (h.precip != null && h.precip >= mmMin);
      if (wet) {
        if (!cur) cur = { from: h, to: h, maxPop: 0, maxMm: 0, snow: false };
        cur.to = h;
        cur.maxPop = Math.max(cur.maxPop, h.pop || 0);
        cur.maxMm = Math.max(cur.maxMm, h.precip || 0);
        if (global.WeatherIcons.isSnowy(h.code)) cur.snow = true;
      } else if (cur) {
        spans.push(cur); cur = null;
      }
    }
    if (cur) spans.push(cur);
    return spans;
  }

  /* ---------------- 集計 ---------------- */

  function summarize(hours) {
    const s = {
      count: hours.length,
      maxPop: 0, sumMm: 0, maxMm: 0,
      minTemp: null, maxTemp: null,
      minFeels: null, maxFeels: null,
      maxWind: 0, anySnow: false, anyThunder: false
    };
    for (const h of hours) {
      if (h.pop != null) s.maxPop = Math.max(s.maxPop, h.pop);
      if (h.precip != null) { s.sumMm += h.precip; s.maxMm = Math.max(s.maxMm, h.precip); }
      if (h.temp != null) {
        s.minTemp = s.minTemp == null ? h.temp : Math.min(s.minTemp, h.temp);
        s.maxTemp = s.maxTemp == null ? h.temp : Math.max(s.maxTemp, h.temp);
      }
      const fe = h.feels != null ? h.feels : h.temp;
      if (fe != null) {
        s.minFeels = s.minFeels == null ? fe : Math.min(s.minFeels, fe);
        s.maxFeels = s.maxFeels == null ? fe : Math.max(s.maxFeels, fe);
      }
      if (h.wind != null) s.maxWind = Math.max(s.maxWind, h.wind);
      if (global.WeatherIcons.isSnowy(h.code)) s.anySnow = true;
      if (h.code === 95 || h.code === 96 || h.code === 99) s.anyThunder = true;
    }
    s.sumMm = Math.round(s.sumMm * 10) / 10;
    return s;
  }

  /* ---------------- 傘 ---------------- */

  function umbrella(hours, opts) {
    const o = opts || {};
    const s = summarize(hours);
    const spans = rainSpans(hours, POP_UMBRELLA, MM_WET);
    const first = spans[0] || null;
    const wetWord = s.anySnow ? '雪' : '雨';

    // 判断の根拠を必ず添える。降水確率と降水量は別のモデル由来のため
    // 「確率は低いのに雨量は多い」ことがあり、両方見せないと納得できないため。
    const detail = [];
    if (s.maxPop != null) detail.push(`降水確率 最大${Math.round(s.maxPop)}%`);
    if (s.sumMm >= 0.5) detail.push(`降水量 合計${s.sumMm}mm`);
    const detailText = detail.length ? `（${detail.join('・')}）` : '';

    let state, title, note;

    if (s.maxPop >= POP_STRONG || s.sumMm >= MM_STRONG) {
      state = 'strong';
      title = s.anySnow ? '雪です。傘と滑らない靴を' : 'しっかりした傘を持って';
      note = first
        ? `${timeWord(first)}に${wetWord}の予報です${detailText}。`
        : `この先${wetWord}の予報です${detailText}。`;
      if (s.maxMm >= 4) note += '短時間に強く降る時間があります。';
    } else if (s.maxPop >= POP_UMBRELLA || s.sumMm >= 1.0) {
      state = 'need';
      title = '傘を持って行きましょう';
      note = first
        ? `${timeWord(first)}に${wetWord}が降るかもしれません${detailText}。`
        : `${wetWord}が降るかもしれません${detailText}。`;
    } else if (s.maxPop >= POP_LIGHT) {
      state = 'folding';
      title = '折りたたみ傘があると安心';
      note = `降水確率は最大${Math.round(s.maxPop)}%。念のため、かばんに1本。`;
    } else {
      state = 'no';
      title = '傘はいりません';
      note = o.rangeLabel
        ? `${o.rangeLabel}は雨の心配はなさそうです。`
        : '雨の心配はなさそうです。';
    }

    if (s.anyThunder && state !== 'no') {
      note += '雷の予報もあります。屋外は注意してください。';
    }

    return { state, title, note, summary: s, spans };
  }

  /** 「9時ごろ」「9時ごろ〜12時ごろ」のような表現 */
  function timeWord(span) {
    if (!span) return '';
    const a = span.from.hour;
    const b = span.to.hour;
    if (a === b) return `${a}時ごろ`;
    return `${a}時ごろ〜${b}時ごろ`;
  }

  /* ---------------- 服装 ---------------- */

  function clothing(hours, opts) {
    const o = Object.assign({ tempPref: 'normal' }, opts || {});
    const s = summarize(hours);
    if (s.minFeels == null) {
      return { level: 1, state: 'unknown', title: '—', note: '', summary: s };
    }

    const shift = PREF_SHIFT[o.tempPref] != null ? PREF_SHIFT[o.tempPref] : 0;
    const basis = s.minFeels + shift;
    const rule = CLOTHING.find((r) => basis >= r.min) || CLOTHING[CLOTHING.length - 1];

    let note = rule.note;

    // 昼と夜の差が大きい日は必ず伝える
    const gap = (s.maxFeels != null && s.minFeels != null) ? s.maxFeels - s.minFeels : 0;
    if (gap >= 7) {
      note = `体感で${Math.round(s.minFeels)}℃〜${Math.round(s.maxFeels)}℃。` +
             '差が大きいので、脱ぎ着しやすい服が便利です。';
    } else if (s.maxFeels != null && s.maxFeels + shift >= 31) {
      note = '蒸し暑くなります。水分をこまめに取ってください。';
    } else if (s.maxWind >= 8) {
      note += `風がやや強めです（最大${Math.round(s.maxWind)}m/s）。`;
    }

    if (o.tempPref === 'cold') note += '（寒がり設定）';
    else if (o.tempPref === 'hot') note += '（暑がり設定）';

    return { level: rule.level, state: 'ok', title: rule.title, note, summary: s };
  }

  /* ---------------- 画面上部の警告 ---------------- */

  /**
   * 「この先雨が降る」ときだけ出す大きな警告。
   * 出しすぎると読まれなくなるので、傘の基準より高めにしています。
   */
  function alert(hours, nowRef) {
    const s = summarize(hours);
    if (s.maxPop < POP_ALERT && s.sumMm < MM_ALERT) return null;

    const spans = rainSpans(hours, POP_ALERT, MM_WET);
    const span = spans[0] || rainSpans(hours, POP_UMBRELLA, MM_WET)[0];
    if (!span) return null;

    const snow = s.anySnow;
    const word = snow ? '雪' : '雨';
    // 「まもなく」は “実際の現在時刻” を基準に判定する。
    // 出かける時間帯で絞り込むと hours[0] が先の時刻になることがあるため。
    const ref = nowRef || hours[0];
    const imminent = ref && span.from.date === ref.date && span.from.hour <= ref.hour + 1;
    const title = imminent
      ? `まもなく${word}が降りそうです`
      : `${span.from.hour}時ごろから${word}の予報です`;

    const parts = [];
    if (spans.length > 0) {
      const last = spans[spans.length - 1];
      parts.push((span.from.hour === last.to.hour)
        ? `${span.from.hour}時ごろ`
        : `${span.from.hour}時ごろ〜${last.to.hour}時ごろ`);
    }
    parts.push(`降水確率 最大${Math.round(s.maxPop)}%`);
    if (s.sumMm >= 1) parts.push(`合計${s.sumMm}mm`);

    return {
      kind: snow ? 'snow' : 'rain',
      title,
      sub: parts.join('・'),
      summary: s
    };
  }

  global.Advice = {
    applySchedule, inSchedule, summarize, rainSpans,
    umbrella, clothing, alert,
    POP_UMBRELLA, POP_STRONG, POP_ALERT
  };

})(window);
