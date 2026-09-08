/* =========================================================================
   app.js  —  おでかけ天気 本体
   ========================================================================= */
(function () {
  'use strict';

  const VERSION = '1.0.0';
  const $ = (id) => document.getElementById(id);

  /* ---------------- 状態 ---------------- */
  let settings = null;
  let places = [];
  let activeId = null;
  let currentData = null;      // 表示中の予報データ
  let currentMeta = null;      // {fetchedAt, age, fresh, error}
  let metric = 'rain';
  let loadToken = 0;           // 地点を切り替えたときに古い結果を捨てるための番号
  let pendingPlace = null;     // 名前入力中の地点
  let editingPlaceId = null;   // 名前を編集中の地点

  /* =====================================================================
     起動
     ===================================================================== */
  function boot() {
    settings = Store.getSettings();
    places = Store.getPlaces();
    metric = 'rain';

    $('appVersion').textContent = VERSION;
    applyTheme();
    watchSystemTheme();
    buildTimeSelects();
    bindEvents();
    registerServiceWorker();

    if (places.length === 0) {
      startOnboarding();
    } else {
      showApp();
      const wanted = settings.activePlaceId && Store.findPlace(settings.activePlaceId)
        ? settings.activePlaceId : places[0].id;
      selectPlace(wanted);
    }
  }

  /* =====================================================================
     テーマ
     ===================================================================== */
  function resolvedTheme() {
    if (settings.theme === 'light' || settings.theme === 'dark') return settings.theme;
    return (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', resolvedTheme());
  }

  function watchSystemTheme() {
    if (!window.matchMedia) return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (settings.theme !== 'auto') return;
      applyTheme();
      if (currentData) applySky(currentData);
    };
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else if (mq.addListener) mq.addListener(handler);
  }

  /* =====================================================================
     オンボーディング（初回起動：いきなり現在地）
     ===================================================================== */
  function startOnboarding() {
    $('onboarding').hidden = false;
    $('app').hidden = true;
    $('onboardingLogo').innerHTML = WeatherIcons.ui.logo(88);
    setOnboardingStatus(true, '現在地を調べています…');
    $('onboardingActions').hidden = true;
    $('onboardingNote').textContent = '';
    tryGpsOnboarding();
  }

  function setOnboardingStatus(busy, text) {
    $('onboardingStatus').hidden = !text;
    $('onboardingSpinner').style.display = busy ? '' : 'none';
    $('onboardingStatusText').textContent = text || '';
  }

  function tryGpsOnboarding() {
    setOnboardingStatus(true, '現在地を調べています…');
    $('onboardingActions').hidden = true;

    Geocode.currentPosition()
      .then((pos) => {
        setOnboardingStatus(true, '住所を調べています…');
        return Geocode.reverse(pos.lat, pos.lon).then((rev) => ({ pos, rev }));
      })
      .then(({ pos, rev }) => {
        const place = Store.addPlace({
          name: (rev.shortName || '現在地').slice(0, 12),
          address: rev.address,
          lat: pos.lat, lon: pos.lon
        });
        places = Store.getPlaces();
        settings = Store.saveSettings({ activePlaceId: place.id });
        $('onboarding').hidden = true;
        showApp();
        selectPlace(place.id);
      })
      .catch((err) => {
        setOnboardingStatus(false, '');
        $('onboardingActions').hidden = false;
        const msg = (err && err.message) || '現在地を取得できませんでした';
        $('onboardingNote').textContent =
          msg + '。地名を入力しても登録できます。';
      });
  }

  function showApp() {
    $('onboarding').hidden = true;
    $('app').hidden = false;
  }

  /* =====================================================================
     地点タブ
     ===================================================================== */
  function renderTabs() {
    const nav = $('placeTabs');
    if (places.length <= 1) {
      // 1地点のときはタブではなく地名だけを見せる
      const p = places[0];
      nav.className = 'tabs tabs--single';
      nav.innerHTML = p
        ? `<span class="tabs__solo" title="${escapeHtml(p.address || '')}">${escapeHtml(p.name)}</span>`
        : '';
      return;
    }
    nav.className = 'tabs';
    nav.innerHTML = places.map((p) =>
      `<button class="tab${p.id === activeId ? ' is-active' : ''}" type="button" ` +
      `data-id="${escapeHtml(p.id)}" role="tab" aria-selected="${p.id === activeId}" ` +
      `title="${escapeHtml(p.address || '')}">${escapeHtml(p.name)}</button>`
    ).join('');

    const active = nav.querySelector('.tab.is-active');
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }

  function selectPlace(id) {
    const place = Store.findPlace(id);
    if (!place) return;
    activeId = id;
    settings = Store.saveSettings({ activePlaceId: id });
    renderTabs();
    loadWeather();
  }

  /* =====================================================================
     予報の読み込み
     ===================================================================== */
  function loadWeather(opts) {
    const o = opts || {};
    const place = Store.findPlace(activeId);
    if (!place) return;

    const token = ++loadToken;
    const cached = Weather.cached(place.id);

    if (cached) {
      currentData = cached.data;
      currentMeta = cached;
      renderAll();
    } else {
      // 別の地点のデータを表示したままにしないよう、いったん空にする
      currentData = null;
      currentMeta = null;
      showLoading();
    }

    if (cached && cached.fresh && !o.force) {
      setUpdating(false);
      return;
    }

    setUpdating(true);
    Weather.fetch(place)
      .then((res) => {
        if (token !== loadToken) return;
        currentData = res.data;
        currentMeta = res;
        renderAll();
        if (o.force) toast('最新の予報にしました');
      })
      .catch((err) => {
        if (token !== loadToken) return;
        if (currentData) {
          currentMeta = Object.assign({}, currentMeta, { error: err });
          renderMeta();
          toast((err && err.message) || '更新できませんでした');
        } else {
          showError(err);
        }
      })
      .finally(() => {
        if (token === loadToken) setUpdating(false);
      });
  }

  function setUpdating(on) {
    document.body.classList.toggle('is-updating', !!on);
  }

  function showLoading() {
    $('nowDesc').textContent = '読み込み中…';
    $('nowTemp').textContent = '--';
    $('nowIcon').innerHTML = '';
    $('mainChart').innerHTML = '<p class="chart-empty">予報を読み込んでいます…</p>';
    $('tomorrowChart').innerHTML = '';
    $('dailyList').innerHTML = '';
    $('rainAlert').hidden = true;
  }

  function showError(err) {
    const msg = (err && err.message) || '予報を取得できませんでした';
    $('nowDesc').textContent = '取得できませんでした';
    $('nowTemp').textContent = '--';
    $('nowIcon').innerHTML = '';
    $('mainChart').innerHTML =
      `<div class="chart-empty chart-empty--error">` +
      `<p>${escapeHtml(msg)}</p>` +
      `<button class="btn btn--outline" type="button" id="btnRetry">もう一度ためす</button></div>`;
    const btn = $('btnRetry');
    if (btn) btn.addEventListener('click', () => loadWeather({ force: true }));
    $('tomorrowChart').innerHTML = '';
    $('dailyList').innerHTML = '';
    $('rainAlert').hidden = true;
  }

  /* =====================================================================
     画面の描画
     ===================================================================== */
  function renderAll() {
    if (!currentData) return;
    const data = currentData;

    const next12 = Weather.nextHours(data, 12);
    const scoped = Advice.applySchedule(next12, settings.schedule);

    applySky(data);
    renderNow(data);
    renderAlert(scoped.hours, scoped.applied, next12[0]);
    renderMainChart(next12);
    renderAdvice(scoped);
    renderTomorrow(data);
    renderDaily(data);
    renderMeta();
  }

  /* --- 空と雨の演出 --- */
  function applySky(data) {
    const cur = data.current || (data.hourly[Weather.nowIndex(data)] || {});
    const today = data.daily && data.daily[0];
    Sky.apply({
      code: cur.code,
      hour: cur.hour,
      sunrise: today && today.sunrise,
      sunset: today && today.sunset,
      darkMode: resolvedTheme() === 'dark'
    });

    if (!settings.rainAnim) { Sky.setPrecip('off', 0); return; }

    const nowHour = data.hourly[Weather.nowIndex(data)];
    const wet = WeatherIcons.isWet(cur.code);
    if (!wet) { Sky.setPrecip('off', 0); return; }
    const mm = (nowHour && nowHour.precip != null) ? nowHour.precip : 1;
    const intensity = Math.max(0.15, Math.min(1, mm / 4));
    Sky.setPrecip(WeatherIcons.isSnowy(cur.code) ? 'snow' : 'rain', intensity);
  }

  /* --- 現在の天気 --- */
  function renderNow(data) {
    const idx = Weather.nowIndex(data);
    const hour = data.hourly[idx] || {};
    const cur = data.current || hour;

    $('nowIcon').innerHTML = WeatherIcons.svg(cur.code, cur.isDay, { size: 56 });
    $('nowTemp').textContent = cur.temp != null ? Math.round(cur.temp) : '--';
    $('nowDesc').textContent = WeatherIcons.label(cur.code);
    const feels = cur.feels != null ? cur.feels : hour.feels;
    $('nowFeels').textContent = feels != null ? `体感 ${Math.round(feels)}℃` : '';
  }

  /* --- 雨の警告 --- */
  function renderAlert(hours, scheduled, nowRef) {
    const el = $('rainAlert');
    const a = Advice.alert(hours, nowRef);
    if (!a) { el.hidden = true; return; }

    el.hidden = false;
    el.setAttribute('data-kind', a.kind);
    $('rainAlertIcon').innerHTML = a.kind === 'snow'
      ? WeatherIcons.ui.alertSnow(46)
      : WeatherIcons.ui.alertRain(46);
    $('rainAlertTitle').textContent = a.title;
    $('rainAlertSub').textContent =
      (scheduled ? '出かける時間帯　' : '') + a.sub;
  }

  /* --- メインの12時間グラフ --- */
  function renderMainChart(next12) {
    Chart.render($('mainChart'), {
      hours: next12,
      metric,
      schedule: settings.schedule,
      markNow: true,
      ariaLabel: 'これから12時間の予報',
      onSelect: openHourSheet
    });

    const anyBand = next12.some((h) => Advice.inSchedule(h, settings.schedule));
    const unitNote = metric === 'wind' ? '棒は風の強さ（m/s）、折れ線は気温（℃）。'
      : metric === 'humidity' ? '棒は湿度（％）、折れ線は気温（℃）。'
      : metric === 'feels' ? '棒は降水確率（％）、実線が気温・点線が体感温度（℃）。'
      : '棒は降水確率（％）、折れ線は気温（℃）。';
    $('chartHint').textContent =
      unitNote +
      (anyBand ? 'うすい帯は出かける時間帯です。' : '') +
      'タップすると詳しく見られます。';
  }

  /* --- 傘と服装 --- */
  function renderAdvice(scoped) {
    const rangeLabel = scoped.applied ? '出かける時間帯' : 'これから12時間';
    const u = Advice.umbrella(scoped.hours, { rangeLabel });
    const c = Advice.clothing(scoped.hours, { tempPref: settings.tempPref });

    const uCard = $('umbrellaCard');
    uCard.setAttribute('data-state', u.state);
    $('umbrellaIcon').innerHTML = WeatherIcons.ui.umbrella(
      u.state === 'no' ? 'no' : (u.state === 'folding' ? 'folding' : 'need'), 42);
    $('umbrellaTitle').textContent = u.title;
    $('umbrellaNote').textContent = u.note;

    $('clothingIcon').innerHTML = WeatherIcons.ui.clothing(c.level, 42);
    $('clothingTitle').textContent = c.title;
    $('clothingNote').textContent = c.note;

    const label = scoped.applied ? '出かける時間帯で判断' : 'これから12時間で判断';
    uCard.querySelector('.advice-card__label').textContent = '傘 ・ ' + label;
    $('clothingCard').querySelector('.advice-card__label').textContent = '服装 ・ ' + label;
  }

  /* --- 明日 --- */
  function renderTomorrow(data) {
    const today = Weather.todayStr(data);
    const tomorrow = Weather.dateAfter(today, 1);
    const hours = Weather.hoursOfDate(data, tomorrow);
    if (!hours.length) {
      $('tomorrowChart').innerHTML = '<p class="chart-empty">明日のデータがありません</p>';
      $('tomorrowDate').textContent = '';
      $('tomorrowSummary').textContent = '';
      return;
    }

    const blocks = Chart.aggregate(hours, 3);
    Chart.render($('tomorrowChart'), {
      hours: blocks,
      metric: metric === 'feels' ? 'feels' : metric,
      schedule: settings.schedule,
      markNow: false,
      ariaLabel: '明日の3時間ごとの予報',
      onSelect: openHourSheet
    });

    const md = `${Number(tomorrow.slice(5, 7))}月${Number(tomorrow.slice(8, 10))}日`;
    const wd = ['日', '月', '火', '水', '木', '金', '土'][Weather.weekdayOf(tomorrow)];
    $('tomorrowDate').textContent = ` ${md}（${wd}）・3時間ごと`;

    const d = (data.daily || []).find((x) => x.date === tomorrow);
    if (d) {
      $('tomorrowSummary').textContent =
        `${Math.round(d.tmax)}℃ / ${Math.round(d.tmin)}℃　降水 ${Math.round(d.popMax || 0)}%`;
    }
  }

  /* --- 5日間 --- */
  function renderDaily(data) {
    const list = (data.daily || []).slice(0, 5);
    const today = Weather.todayStr(data);

    // 気温バーの共通スケール
    let lo = Infinity, hi = -Infinity;
    for (const d of list) {
      if (d.tmin != null) lo = Math.min(lo, d.tmin);
      if (d.tmax != null) hi = Math.max(hi, d.tmax);
    }
    if (!isFinite(lo) || !isFinite(hi) || hi - lo < 1) { lo = 0; hi = 1; }

    $('dailyList').innerHTML = list.map((d, i) => {
      const wdIdx = Weather.weekdayOf(d.date);
      const wd = ['日', '月', '火', '水', '木', '金', '土'][wdIdx];
      const label = d.date === today ? '今日'
        : (i === 1 ? '明日' : `${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8, 10))}`);
      const wdCls = wdIdx === 0 ? ' is-sun' : (wdIdx === 6 ? ' is-sat' : '');
      const left = ((d.tmin - lo) / (hi - lo)) * 100;
      const width = Math.max(6, ((d.tmax - d.tmin) / (hi - lo)) * 100);
      const pop = d.popMax != null ? Math.round(d.popMax) : null;

      return `<div class="daily-row">` +
        `<div class="daily-row__day${wdCls}">` +
          `<span class="daily-row__label">${escapeHtml(label)}</span>` +
          `<span class="daily-row__wd">${wd}</span></div>` +
        `<div class="daily-row__icon">${WeatherIcons.svg(d.code, 1, { size: 30 })}</div>` +
        `<div class="daily-row__pop${pop != null && pop >= 30 ? ' is-wet' : ''}">` +
          (pop != null ? pop + '%' : '—') + `</div>` +
        `<div class="daily-row__bar">` +
          `<span class="daily-row__range" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></span>` +
        `</div>` +
        `<div class="daily-row__temps">` +
          `<span class="daily-row__min">${d.tmin != null ? Math.round(d.tmin) : '--'}</span>` +
          `<span class="daily-row__max">${d.tmax != null ? Math.round(d.tmax) : '--'}</span>` +
        `</div>` +
      `</div>`;
    }).join('');
  }

  /* --- 更新時刻 --- */
  function renderMeta() {
    const el = $('updatedAt');
    if (!currentMeta) { el.textContent = ''; return; }
    const age = Date.now() - currentMeta.fetchedAt;
    let s;
    if (age < 60 * 1000) s = 'たった今の情報です';
    else if (age < 60 * 60 * 1000) s = `${Math.floor(age / 60000)}分前の情報です`;
    else s = `${Math.floor(age / 3600000)}時間前の情報です`;
    if (currentMeta.error) s += '（最新に更新できませんでした）';
    el.textContent = s;
    el.classList.toggle('is-stale', age > Weather.FRESH_MS * 3 || !!currentMeta.error);
  }

  /* =====================================================================
     時刻の詳細シート
     ===================================================================== */
  function openHourSheet(h) {
    const spanNote = h.span && h.span > 1 ? `〜${(h.hour + h.span) % 24}時` : '';
    $('hourTime').textContent = `${h.hour}時${spanNote}`;
    $('hourDesc').textContent = WeatherIcons.label(h.code);
    $('hourTemp').textContent = h.temp != null ? Math.round(h.temp) : '--';
    $('hourIcon').innerHTML = WeatherIcons.svg(h.code, h.isDay, { size: 52 });

    const rows = [
      ['体感温度', h.feels != null ? Math.round(h.feels) + '℃' : '—'],
      ['降水確率', h.pop != null ? Math.round(h.pop) + '%' : '—'],
      ['降水量', h.precip != null ? (Math.round(h.precip * 10) / 10) + 'mm' : '—'],
      ['湿度', h.humidity != null ? Math.round(h.humidity) + '%' : '—'],
      ['風速', h.wind != null ? (Math.round(h.wind * 10) / 10) + 'm/s' : '—']
    ];
    $('hourDetail').innerHTML = rows.map(([k, v]) =>
      `<div class="hour-detail__row"><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join('');

    $('hourSheet').hidden = false;
    requestAnimationFrame(() => $('hourSheet').classList.add('is-open'));
  }

  function closeHourSheet() {
    const el = $('hourSheet');
    el.classList.remove('is-open');
    setTimeout(() => { el.hidden = true; }, 200);
  }

  /* =====================================================================
     設定
     ===================================================================== */
  function openSettings() {
    renderPlaceList();
    syncSettingsUi();
    $('settingsScreen').hidden = false;
  }

  function closeSettings() {
    $('settingsScreen').hidden = true;
  }

  function syncSettingsUi() {
    setSegmented('tempPref', settings.tempPref);
    setSegmented('themePref', settings.theme);
    $('rainAnimEnabled').checked = settings.rainAnim;

    $('weekdayEnabled').checked = settings.schedule.weekday.enabled;
    $('weekdayStart').value = String(settings.schedule.weekday.start);
    $('weekdayEnd').value = String(settings.schedule.weekday.end);
    $('holidayEnabled').checked = settings.schedule.holiday.enabled;
    $('holidayStart').value = String(settings.schedule.holiday.start);
    $('holidayEnd').value = String(settings.schedule.holiday.end);

    $('weekdayRange').classList.toggle('is-off', !settings.schedule.weekday.enabled);
    $('holidayRange').classList.toggle('is-off', !settings.schedule.holiday.enabled);
  }

  function setSegmented(groupId, value) {
    const g = $(groupId);
    Array.prototype.forEach.call(g.querySelectorAll('.segmented__item'), (b) => {
      const on = b.getAttribute('data-value') === value;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function renderPlaceList() {
    const ul = $('placeList');
    if (!places.length) {
      ul.innerHTML = '<li class="place-empty">まだ登録がありません</li>';
      return;
    }
    ul.innerHTML = places.map((p, i) =>
      `<li class="place-item" data-id="${escapeHtml(p.id)}">` +
        `<div class="place-item__main">` +
          `<span class="place-item__name">${escapeHtml(p.name)}</span>` +
          `<span class="place-item__addr">${escapeHtml(p.address || '')}</span>` +
        `</div>` +
        `<div class="place-item__ops">` +
          `<button class="icon-btn icon-btn--sm" type="button" data-op="up" ${i === 0 ? 'disabled' : ''} aria-label="${escapeHtml(p.name)}を上へ">` +
            `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 18V7m0 0-5 5m5-5 5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` +
          `<button class="icon-btn icon-btn--sm" type="button" data-op="down" ${i === places.length - 1 ? 'disabled' : ''} aria-label="${escapeHtml(p.name)}を下へ">` +
            `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 6v11m0 0 5-5m-5 5-5-5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` +
          `<button class="icon-btn icon-btn--sm" type="button" data-op="rename" aria-label="${escapeHtml(p.name)}の名前を変える">` +
            `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 20h4L19 9l-4-4L4 16v4Z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/></svg></button>` +
          `<button class="icon-btn icon-btn--sm icon-btn--danger" type="button" data-op="delete" aria-label="${escapeHtml(p.name)}を削除">` +
            `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 7h12M10 7V5h4v2m-7 0 1 13h8l1-13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` +
        `</div>` +
      `</li>`).join('');
  }

  function handlePlaceOp(id, op) {
    const place = Store.findPlace(id);
    if (!place) return;

    if (op === 'up' || op === 'down') {
      places = Store.movePlace(id, op === 'up' ? -1 : 1);
      renderPlaceList();
      renderTabs();
      return;
    }
    if (op === 'rename') {
      editingPlaceId = id;
      pendingPlace = null;
      $('nameAddress').textContent = place.address || '';
      $('nameInput').value = place.name;
      $('namePlaceScreen').hidden = false;
      setTimeout(() => $('nameInput').focus(), 50);
      return;
    }
    if (op === 'delete') {
      if (places.length <= 1) {
        toast('最後の1つは消せません。先に別の場所を追加してください。');
        return;
      }
      if (!confirm(`「${place.name}」を削除しますか？`)) return;
      places = Store.removePlace(id);
      if (activeId === id) {
        activeId = places[0].id;
        settings = Store.saveSettings({ activePlaceId: activeId });
        loadWeather();
      }
      renderPlaceList();
      renderTabs();
      toast('削除しました');
    }
  }

  /* =====================================================================
     地点の追加
     ===================================================================== */
  let searchTimer = 0;
  let searchSeq = 0;

  function openAddPlace() {
    $('addPlaceScreen').hidden = false;
    $('searchInput').value = '';
    $('searchResults').innerHTML = '';
    $('searchClear').hidden = true;
    setSearchHint('町名・丁目まで入力すると、より正確な予報になります。');
    setTimeout(() => $('searchInput').focus(), 60);
  }

  function closeAddPlace() {
    $('addPlaceScreen').hidden = true;
    clearTimeout(searchTimer);
  }

  function setSearchHint(text, isError) {
    const el = $('searchHint');
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  function onSearchInput() {
    const q = $('searchInput').value.trim();
    $('searchClear').hidden = q.length === 0;
    clearTimeout(searchTimer);
    if (q.length === 0) {
      $('searchResults').innerHTML = '';
      setSearchHint('町名・丁目まで入力すると、より正確な予報になります。');
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), 350);
  }

  function runSearch(q) {
    const seq = ++searchSeq;
    setSearchHint('探しています…');
    Geocode.search(q)
      .then((rows) => {
        if (seq !== searchSeq) return;
        if (!rows.length) {
          $('searchResults').innerHTML = '';
          setSearchHint('見つかりませんでした。市区町村名から入れてみてください（例：世田谷区 三軒茶屋）', true);
          return;
        }
        setSearchHint(`${rows.length}件見つかりました。タップして登録します。`);
        $('searchResults').innerHTML = rows.map((r, i) =>
          `<li><button class="result" type="button" data-i="${i}">` +
            `<span class="result__title">${escapeHtml(r.title)}</span>` +
            `<span class="result__kind">${r.kind === 'facility' ? '施設' : (r.source === 'openmeteo' ? '地名' : '住所')}</span>` +
          `</button></li>`).join('');
        $('searchResults').__rows = rows;
      })
      .catch(() => {
        if (seq !== searchSeq) return;
        setSearchHint('検索できませんでした。通信状況を確かめてください。', true);
      });
  }

  function pickResult(i) {
    const rows = $('searchResults').__rows || [];
    const r = rows[i];
    if (!r) return;
    const dup = Store.findPlaceNear(r.lat, r.lon);
    if (dup) {
      toast(`「${dup.name}」として登録済みです`);
      return;
    }
    pendingPlace = { address: r.title, lat: r.lat, lon: r.lon };
    editingPlaceId = null;
    $('nameAddress').textContent = r.title;
    $('nameInput').value = Geocode.suggestName(r.title);
    $('namePlaceScreen').hidden = false;
    setTimeout(() => { $('nameInput').focus(); $('nameInput').select(); }, 50);
  }

  function addFromGps() {
    const btn = $('btnAddFromGps');
    btn.disabled = true;
    setSearchHint('現在地を調べています…');
    Geocode.currentPosition()
      .then((pos) => Geocode.reverse(pos.lat, pos.lon).then((rev) => ({ pos, rev })))
      .then(({ pos, rev }) => {
        const dup = Store.findPlaceNear(pos.lat, pos.lon);
        if (dup) { toast(`「${dup.name}」として登録済みです`); setSearchHint(''); return; }
        pendingPlace = { address: rev.address, lat: pos.lat, lon: pos.lon };
        editingPlaceId = null;
        $('nameAddress').textContent = rev.address;
        $('nameInput').value = rev.shortName || '現在地';
        $('namePlaceScreen').hidden = false;
        setSearchHint('');
        setTimeout(() => { $('nameInput').focus(); $('nameInput').select(); }, 50);
      })
      .catch((err) => setSearchHint((err && err.message) || '現在地を取得できませんでした', true))
      .finally(() => { btn.disabled = false; });
  }

  function saveName() {
    const name = $('nameInput').value.trim().slice(0, 12);
    if (!name) { toast('名前を入れてください'); return; }

    if (editingPlaceId) {
      Store.updatePlace(editingPlaceId, { name });
      places = Store.getPlaces();
      editingPlaceId = null;
      $('namePlaceScreen').hidden = true;
      renderPlaceList();
      renderTabs();
      toast('名前を変えました');
      return;
    }

    if (!pendingPlace) { $('namePlaceScreen').hidden = true; return; }
    const place = Store.addPlace(Object.assign({ name }, pendingPlace));
    pendingPlace = null;
    places = Store.getPlaces();
    $('namePlaceScreen').hidden = true;
    closeAddPlace();

    if ($('onboarding').hidden === false) {
      $('onboarding').hidden = true;
      showApp();
    }
    renderPlaceList();
    selectPlace(place.id);
    toast(`「${place.name}」を追加しました`);
  }

  /* =====================================================================
     引っ張って更新
     ===================================================================== */
  function setupPullToRefresh() {
    const main = $('main');
    const ind = $('pullIndicator');
    let startY = 0, pulling = false, dist = 0;
    const THRESHOLD = 72;

    main.addEventListener('touchstart', (e) => {
      if (window.scrollY > 0 || e.touches.length !== 1) { pulling = false; return; }
      startY = e.touches[0].clientY;
      pulling = true;
      dist = 0;
    }, { passive: true });

    main.addEventListener('touchmove', (e) => {
      if (!pulling) return;
      dist = e.touches[0].clientY - startY;
      if (dist <= 0 || window.scrollY > 0) { reset(); return; }
      const shown = Math.min(THRESHOLD * 1.4, dist * 0.5);
      ind.style.transform = `translateY(${shown}px)`;
      ind.style.opacity = String(Math.min(1, shown / THRESHOLD));
      ind.classList.toggle('is-ready', dist >= THRESHOLD * 2);
      $('pullText').textContent = dist >= THRESHOLD * 2 ? '離すと更新します' : '引っ張って更新';
    }, { passive: true });

    main.addEventListener('touchend', () => {
      if (!pulling) return;
      if (dist >= THRESHOLD * 2) {
        $('pullText').textContent = '更新しています…';
        loadWeather({ force: true });
      }
      reset();
    });

    function reset() {
      pulling = false;
      dist = 0;
      ind.style.transform = '';
      ind.style.opacity = '';
      ind.classList.remove('is-ready');
      $('pullText').textContent = '引っ張って更新';
    }
  }

  /* =====================================================================
     イベント登録
     ===================================================================== */
  function bindEvents() {
    // 地点タブ
    $('placeTabs').addEventListener('click', (e) => {
      const t = e.target.closest('.tab');
      if (t) selectPlace(t.getAttribute('data-id'));
    });

    // 表示項目タブ
    $('metricTabs').addEventListener('click', (e) => {
      const t = e.target.closest('.metric-tab');
      if (!t) return;
      metric = t.getAttribute('data-metric');
      Array.prototype.forEach.call($('metricTabs').children, (b) => {
        const on = b === t;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (currentData) {
        renderMainChart(Weather.nextHours(currentData, 12));
        renderTomorrow(currentData);
      }
    });

    // 設定
    $('btnSettings').addEventListener('click', openSettings);
    $('btnCloseSettings').addEventListener('click', closeSettings);
    $('btnReload').addEventListener('click', () => loadWeather({ force: true }));

    $('placeList').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-op]');
      if (!b) return;
      const li = b.closest('.place-item');
      handlePlaceOp(li.getAttribute('data-id'), b.getAttribute('data-op'));
    });

    $('btnAddPlace').addEventListener('click', openAddPlace);
    $('btnCloseAdd').addEventListener('click', closeAddPlace);
    $('btnAddFromGps').addEventListener('click', addFromGps);

    $('searchInput').addEventListener('input', onSearchInput);
    $('searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(searchTimer);
        const q = $('searchInput').value.trim();
        if (q) runSearch(q);
      }
    });
    $('searchClear').addEventListener('click', () => {
      $('searchInput').value = '';
      onSearchInput();
      $('searchInput').focus();
    });
    $('searchResults').addEventListener('click', (e) => {
      const b = e.target.closest('.result');
      if (b) pickResult(Number(b.getAttribute('data-i')));
    });

    // 名前をつける
    $('btnSaveName').addEventListener('click', saveName);
    $('btnCancelName').addEventListener('click', () => {
      $('namePlaceScreen').hidden = true;
      pendingPlace = null;
      editingPlaceId = null;
    });
    $('nameInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveName(); }
    });
    $('nameChips').addEventListener('click', (e) => {
      const c = e.target.closest('.chip');
      if (!c) return;
      $('nameInput').value = c.getAttribute('data-name');
      $('nameInput').focus();
    });

    // 暑がり・寒がり／テーマ
    $('tempPref').addEventListener('click', (e) => {
      const b = e.target.closest('.segmented__item');
      if (!b) return;
      settings = Store.saveSettings({ tempPref: b.getAttribute('data-value') });
      setSegmented('tempPref', settings.tempPref);
      if (currentData) renderAll();
    });

    $('themePref').addEventListener('click', (e) => {
      const b = e.target.closest('.segmented__item');
      if (!b) return;
      settings = Store.saveSettings({ theme: b.getAttribute('data-value') });
      setSegmented('themePref', settings.theme);
      applyTheme();
      if (currentData) applySky(currentData);
    });

    $('rainAnimEnabled').addEventListener('change', (e) => {
      settings = Store.saveSettings({ rainAnim: e.target.checked });
      if (currentData) applySky(currentData);
    });

    // 出かける時間帯
    ['weekday', 'holiday'].forEach((kind) => {
      $(kind + 'Enabled').addEventListener('change', () => saveSchedule(kind));
      $(kind + 'Start').addEventListener('change', () => saveSchedule(kind));
      $(kind + 'End').addEventListener('change', () => saveSchedule(kind));
    });

    // 時刻の詳細
    $('btnCloseHour').addEventListener('click', closeHourSheet);
    $('hourSheet').addEventListener('click', (e) => {
      if (e.target === $('hourSheet')) closeHourSheet();
    });

    // オンボーディング
    $('btnUseGps').addEventListener('click', tryGpsOnboarding);
    $('btnSearchInstead').addEventListener('click', () => {
      openAddPlace();
    });

    // Esc で閉じる
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('hourSheet').hidden) { closeHourSheet(); return; }
      if (!$('namePlaceScreen').hidden) { $('namePlaceScreen').hidden = true; return; }
      if (!$('addPlaceScreen').hidden) { closeAddPlace(); return; }
      if (!$('settingsScreen').hidden) { closeSettings(); }
    });

    // 画面に戻ってきたら情報を新しくする
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !currentData) return;
      renderMeta();
      const c = Weather.cached(activeId);
      if (!c || !c.fresh) loadWeather();
    });

    window.addEventListener('online', () => { if (activeId) loadWeather({ force: true }); });

    setupPullToRefresh();
    setInterval(renderMeta, 60 * 1000);
  }

  function saveSchedule(kind) {
    const enabled = $(kind + 'Enabled').checked;
    let start = Number($(kind + 'Start').value);
    let end = Number($(kind + 'End').value);
    if (end <= start) {
      end = Math.min(23, start + 1);
      $(kind + 'End').value = String(end);
      toast('終わりの時刻は、始まりより後にしてください');
    }
    const schedule = JSON.parse(JSON.stringify(settings.schedule));
    schedule[kind] = { enabled, start, end };
    settings = Store.saveSettings({ schedule });
    $(kind + 'Range').classList.toggle('is-off', !enabled);
    if (currentData) renderAll();
  }

  function buildTimeSelects() {
    const opts = [];
    for (let h = 0; h < 24; h++) opts.push(`<option value="${h}">${h}時</option>`);
    ['weekdayStart', 'weekdayEnd', 'holidayStart', 'holidayEnd'].forEach((id) => {
      $(id).innerHTML = opts.join('');
    });
  }

  /* =====================================================================
     こまごま
     ===================================================================== */
  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('is-show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('is-show');
      setTimeout(() => { el.hidden = true; }, 250);
    }, 2600);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* 失敗しても動きます */ });
    });
  }

  /* ---------------- 起動 ---------------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
