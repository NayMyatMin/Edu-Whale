// Next-48-hours charts: two small multiples sharing one time axis (never a
// dual axis) — wind (gusts + steady wind lines) and rain per hour (columns).
// Synced crosshair with one tooltip listing every series (values lead),
// keyboard ←/→, a legend with line keys and a table view. Marks follow the
// dataviz spec: 2 px lines, ≤ 24 px columns with 4 px rounded tops and 2 px
// gaps, solid hairline grids, text in ink tokens only (never series colour).

import { THRESHOLDS } from './config.js';
import {
  formatDateTime,
  formatDay,
  formatHour,
  formatNumber,
  formatPercent,
  formatRain,
  formatTime,
  formatWhen,
  formatWind,
  rainUnitLabel,
  rainValue,
  t,
  windUnitLabel,
  windValue,
} from './i18n.js';
import { fill, h, icon, svgEl } from './ui/dom.js';

const HOUR = 3600e3;
const PAST_HOURS = 2;
const WIND_PLOT_H = 150;
const RAIN_PLOT_H = 96;
const M = { left: 38, right: 10, top: 18, windBottom: 6, rainBottom: 34 };
const MAX_COL_W = 24;
const COL_GAP = 2;
const COL_RADIUS = 4;
const GUST_REFS = [
  ['monitor', 1],
  ['prepare', 2],
  ['danger', 3],
];

const state = new WeakMap();

function niceStep(max, targetTicks = 5) {
  const raw = max / targetTicks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

function niceScale(max, floor) {
  const top = Math.max(floor, max * 1.15);
  const step = niceStep(top);
  return { max: Math.ceil(top / step - 1e-9) * step, step };
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function linePath(points) {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (!p) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** Column with a rounded data end (top) and a square baseline. */
function columnPath(x0, x1, top, base) {
  const r = Math.min(COL_RADIUS, (x1 - x0) / 2, base - top);
  return `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${base}Z`;
}

function dataFor(weather, now, hours) {
  const start = now.getTime() - PAST_HOURS * HOUR;
  const end = now.getTime() + hours * HOUR;
  return (weather?.hourly ?? [])
    .filter((e) => e.time instanceof Date && e.time.getTime() >= start && e.time.getTime() <= end)
    .map((e) => ({
      time: e.time,
      gust: windValue(e.windGusts),
      wind: windValue(e.windSpeed),
      rain: rainValue(e.precipitation),
      prob: isNum(e.precipProbability) ? e.precipProbability : null,
      raw: e,
    }));
}

function maxBy(rows, key) {
  let best = null;
  for (const r of rows) if (isNum(r.raw[key]) && (!best || r.raw[key] > best.raw[key])) best = r;
  return best;
}

function summaries(rows, now) {
  const future = rows.filter((r) => r.time >= now);
  const g = maxBy(future, 'windGusts');
  const w = maxBy(future, 'windSpeed');
  const r = maxBy(future, 'precipitation');
  const total = future.reduce((s, x) => s + (isNum(x.raw.precipitation) ? x.raw.precipitation : 0), 0);
  const wind = g
    ? t('chart.wind.summary', { gust: formatWind(g.raw.windGusts), time: formatWhen(g.time, now), wind: w ? formatWind(w.raw.windSpeed) : '–' })
    : t('chart.noData');
  const rain =
    r && r.raw.precipitation > 0
      ? t('chart.rain.summary', { total: formatRain(total), max: formatRain(r.raw.precipitation), time: formatWhen(r.time, now) })
      : t('chart.rain.none');
  return { wind, rain, maxGust: g, maxRain: r && r.raw.precipitation > 0 ? r : null };
}

function tableView(rows) {
  return h(
    'table',
    { class: 'hc-table-el' },
    h('caption', { text: t('chart.tableCaption') }),
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { scope: 'col', text: t('chart.col.time') }),
        h('th', { scope: 'col', text: `${t('chart.gusts')} (${windUnitLabel()})` }),
        h('th', { scope: 'col', text: `${t('chart.wind')} (${windUnitLabel()})` }),
        h('th', { scope: 'col', text: `${t('chart.rain')} (${rainUnitLabel()})` }),
        h('th', { scope: 'col', text: t('chart.col.chance') }),
      ),
    ),
    h(
      'tbody',
      {},
      rows.map((r) =>
        h(
          'tr',
          {},
          h('th', { scope: 'row', text: `${formatDay(r.time, { weekdayOnly: true })} ${formatTime(r.time)}` }),
          h('td', { text: isNum(r.gust) ? formatNumber(r.gust) : '–' }),
          h('td', { text: isNum(r.wind) ? formatNumber(r.wind) : '–' }),
          h('td', { text: isNum(r.rain) ? formatNumber(r.rain, { maximumFractionDigits: rainUnitLabel() === 'mm' ? 1 : 2 }) : '–' }),
          h('td', { text: r.prob != null ? formatPercent(r.prob) : '–' }),
        ),
      ),
    ),
  );
}

function legendItem(kind, cls, label) {
  const key =
    kind === 'line'
      ? h('span', { class: `key key-line ${cls}`, 'aria-hidden': 'true' })
      : h('span', { class: `key key-rect ${cls}`, 'aria-hidden': 'true' });
  return h('li', {}, key, h('span', { text: label }));
}

/**
 * Render (or re-render) the 48-hour charts into `container`.
 * @param {HTMLElement} container
 * @param {object|null} weather WeatherData
 * @param {{now?: Date, hours?: number}} [opts]
 */
export function renderHourlyCharts(container, weather, { now = new Date(), hours = 48 } = {}) {
  if (!container) return;
  const prev = state.get(container);
  prev?.cleanup?.();
  const rows = dataFor(weather, now, hours);
  if (rows.length < 3) {
    fill(container, h('p', { class: 'notice notice-warn' }, icon('alert', { size: 20 }), h('span', { text: t('chart.unavailable') })));
    state.delete(container);
    return;
  }

  const sums = summaries(rows, now);
  const hintId = `hc-hint-${Math.random().toString(36).slice(2, 8)}`;
  const windSvg = svgEl('svg', { class: 'hc-svg', role: 'img', 'aria-label': sums.wind });
  const rainSvg = svgEl('svg', { class: 'hc-svg', role: 'img', 'aria-label': sums.rain });
  const tooltip = h('div', { class: 'hc-tooltip', hidden: true });
  const live = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });
  const charts = h(
    'div',
    { class: 'hc-charts', tabindex: '0', 'aria-describedby': hintId, 'aria-label': t('chart.focusLabel') },
    h('div', { class: 'hc-chart' }, h('p', { class: 'hc-title', text: t('chart.windTitle', { unit: windUnitLabel() }) }), windSvg),
    h('div', { class: 'hc-chart' }, h('p', { class: 'hc-title', text: t('chart.rainTitle', { unit: rainUnitLabel() }) }), rainSvg),
    tooltip,
  );
  const tableWrap = h('div', { class: 'hc-table table-scroll', hidden: true }, tableView(rows));
  const showTable = prev?.showTable === true;
  const toggle = h(
    'button',
    { type: 'button', class: 'btn btn-quiet btn-sm hc-toggle', 'aria-pressed': String(showTable) },
    icon(showTable ? 'chart' : 'table', { size: 18 }),
    h('span', { text: t(showTable ? 'chart.showChart' : 'chart.showTable') }),
  );
  charts.hidden = showTable;
  tableWrap.hidden = !showTable;

  const figure = h(
    'figure',
    { class: 'hc' },
    h(
      'div',
      { class: 'hc-head' },
      h(
        'ul',
        { class: 'hc-legend', 'aria-label': t('chart.legend') },
        legendItem('line', 's-gust', t('chart.gusts')),
        legendItem('line', 's-wind', t('chart.wind')),
        legendItem('rect', 's-rain', t('chart.rain')),
      ),
      toggle,
    ),
    charts,
    tableWrap,
    h('p', { class: 'hc-hint muted small', id: hintId, text: t('chart.hint'), hidden: showTable }),
    live,
    h('figcaption', { class: 'muted small', text: t('chart.caption') }),
  );
  fill(container, figure);

  const st = { showTable, active: null, width: 0, geom: null, cleanup: null };
  state.set(container, st);

  toggle.addEventListener('click', () => {
    st.showTable = !st.showTable;
    renderHourlyCharts(container, weather, { now, hours });
    container.querySelector('.hc-toggle')?.focus();
  });

  // --- drawing -------------------------------------------------------------
  const t0 = rows[0].time.getTime() - HOUR / 2;
  const t1 = rows[rows.length - 1].time.getTime() + HOUR / 2;

  function draw() {
    const width = Math.max(260, Math.floor(charts.clientWidth || container.clientWidth || 320));
    st.width = width;
    const plotW = width - M.left - M.right;
    const x = (ms) => M.left + ((ms - t0) / (t1 - t0)) * plotW;
    const slot = plotW / rows.length;
    const narrow = width < 460;

    // Wind
    const windMaxVal = Math.max(0, ...rows.map((r) => Math.max(r.gust ?? 0, r.wind ?? 0)));
    const ws = niceScale(windMaxVal, windValue(60));
    const wy = (v) => M.top + WIND_PLOT_H - (v / ws.max) * WIND_PLOT_H;
    const windH = M.top + WIND_PLOT_H + M.windBottom;
    windSvg.replaceChildren();
    windSvg.setAttribute('viewBox', `0 0 ${width} ${windH}`);
    windSvg.setAttribute('width', String(width));
    windSvg.setAttribute('height', String(windH));

    // Rain
    const rainMaxVal = Math.max(0, ...rows.map((r) => r.rain ?? 0));
    const rs = niceScale(rainMaxVal, rainValue(10));
    const ry = (v) => M.top + RAIN_PLOT_H - (v / rs.max) * RAIN_PLOT_H;
    const rainH = M.top + RAIN_PLOT_H + M.rainBottom;
    rainSvg.replaceChildren();
    rainSvg.setAttribute('viewBox', `0 0 ${width} ${rainH}`);
    rainSvg.setAttribute('width', String(width));
    rainSvg.setAttribute('height', String(rainH));

    const grid = (svg, scale, y, digits = 0) => {
      const g = svgEl('g', { class: 'hc-grid' });
      for (let v = 0; v <= scale.max + 1e-9; v += scale.step) {
        const yy = Math.round(y(v)) + 0.5;
        g.append(svgEl('line', { x1: M.left, x2: width - M.right, y1: yy, y2: yy, class: v === 0 ? 'hc-baseline' : 'hc-gridline' }));
        const label = svgEl('text', { x: M.left - 6, y: yy + 4, class: 'hc-tick', 'text-anchor': 'end' });
        label.textContent = formatNumber(v, { maximumFractionDigits: digits });
        g.append(label);
      }
      svg.append(g);
    };
    grid(windSvg, ws, wy);
    grid(rainSvg, rs, ry, rs.step < 1 ? 2 : rs.step < 5 && rs.step % 1 ? 1 : 0);

    // Midnight separators (Yangon) on both charts + day/hour labels under the rain chart.
    const sepW = svgEl('g', { class: 'hc-seps' });
    const sepR = svgEl('g', { class: 'hc-seps' });
    const ticks = svgEl('g', { class: 'hc-xticks' });
    const stepH = narrow ? 12 : 6;
    let lastLabelX = -Infinity;
    for (let ms = Math.ceil(t0 / HOUR) * HOUR; ms <= t1; ms += HOUR / 2) {
      const d = new Date(ms);
      const local = new Date(ms + 390 * 60e3);
      if (local.getUTCMinutes() !== 0) continue;
      const hr = local.getUTCHours();
      const xx = Math.round(x(ms)) + 0.5;
      if (hr === 0) {
        sepW.append(svgEl('line', { x1: xx, x2: xx, y1: M.top - 4, y2: M.top + WIND_PLOT_H, class: 'hc-sep' }));
        sepR.append(svgEl('line', { x1: xx, x2: xx, y1: M.top - 4, y2: M.top + RAIN_PLOT_H + 6, class: 'hc-sep' }));
      }
      if (hr % stepH === 0 && xx - lastLabelX > (hr === 0 ? 48 : 26) && xx > M.left + 8 && xx < width - M.right - 8) {
        const label = svgEl('text', { x: xx, y: M.top + RAIN_PLOT_H + 20, class: hr === 0 ? 'hc-tick hc-tick-day' : 'hc-tick', 'text-anchor': 'middle' });
        label.textContent = hr === 0 ? formatDay(d, { weekdayOnly: true }) : formatHour(d);
        ticks.append(label);
        lastLabelX = xx;
      }
    }
    windSvg.append(sepW);
    rainSvg.append(sepR, ticks);

    // Reference hairlines at the gust thresholds that fall inside the axis.
    const refs = svgEl('g', { class: 'hc-refs' });
    for (const [band, level] of GUST_REFS) {
      const kmh = THRESHOLDS.weather[band]?.gustKmh;
      const v = windValue(kmh);
      if (!isNum(v) || v > ws.max) continue;
      const yy = Math.round(wy(v)) + 0.5;
      refs.append(svgEl('line', { x1: M.left, x2: width - M.right, y1: yy, y2: yy, class: `hc-ref hc-ref-${band}` }));
      // Right end: the "Now" line sits near the left edge and would cross it.
      const label = svgEl('text', { x: width - M.right - 4, y: yy - 3, class: 'hc-ref-label', 'text-anchor': 'end' });
      label.textContent = t('chart.refGusts', { level: t(`level.${['calm', 'monitor', 'prepare', 'danger'][level]}.name`) });
      refs.append(label);
    }
    windSvg.append(refs);

    // Now marker.
    const nx = Math.round(x(now.getTime())) + 0.5;
    for (const [svg, hgt] of [
      [windSvg, WIND_PLOT_H],
      [rainSvg, RAIN_PLOT_H],
    ]) {
      svg.append(svgEl('line', { x1: nx, x2: nx, y1: M.top - 6, y2: M.top + hgt, class: 'hc-now' }));
    }
    const nowLabel = svgEl('text', { x: nx + 4, y: M.top - 6, class: 'hc-now-label' });
    nowLabel.textContent = t('chart.now');
    windSvg.append(nowLabel);

    // Columns (rain).
    const colW = Math.max(1, Math.min(MAX_COL_W, slot - COL_GAP));
    const cols = svgEl('g', { class: 'hc-cols' });
    const colEls = rows.map((r) => {
      if (!isNum(r.rain) || r.rain <= 0) return null;
      const cx = x(r.time.getTime());
      const top = Math.min(ry(r.rain), M.top + RAIN_PLOT_H - 1);
      const path = svgEl('path', { d: columnPath(cx - colW / 2, cx + colW / 2, top, M.top + RAIN_PLOT_H), class: 'hc-col' });
      cols.append(path);
      return path;
    });
    rainSvg.append(cols);
    if (sums.maxRain) {
      const r = rows.find((row) => row.time === sums.maxRain.time);
      if (r) {
        const label = svgEl('text', { x: clampX(x(r.time.getTime()), width), y: ry(r.rain) - 6, class: 'hc-value', 'text-anchor': 'middle' });
        label.textContent = formatRain(r.raw.precipitation);
        rainSvg.append(label);
      }
    }

    // Lines (wind).
    const pts = (key) => rows.map((r) => (isNum(r[key]) ? [x(r.time.getTime()), wy(r[key])] : null));
    windSvg.append(svgEl('path', { d: linePath(pts('wind')), class: 'hc-line s-wind' }));
    windSvg.append(svgEl('path', { d: linePath(pts('gust')), class: 'hc-line s-gust' }));
    if (sums.maxGust) {
      const r = rows.find((row) => row.time === sums.maxGust.time);
      if (r && isNum(r.gust)) {
        const cx = x(r.time.getTime());
        const cy = wy(r.gust);
        windSvg.append(svgEl('circle', { cx, cy, r: 4, class: 'hc-dot s-gust' }));
        const label = svgEl('text', { x: clampX(cx, width), y: cy - 9, class: 'hc-value', 'text-anchor': 'middle' });
        label.textContent = formatWind(r.raw.windGusts);
        windSvg.append(label);
      }
    }

    // Crosshair layer (drawn on top, hidden until used).
    const crossW = svgEl('line', { y1: M.top - 6, y2: M.top + WIND_PLOT_H, class: 'hc-cross', visibility: 'hidden' });
    const crossR = svgEl('line', { y1: M.top - 6, y2: M.top + RAIN_PLOT_H, class: 'hc-cross', visibility: 'hidden' });
    const dotG = svgEl('circle', { r: 4, class: 'hc-dot s-gust', visibility: 'hidden' });
    const dotW = svgEl('circle', { r: 4, class: 'hc-dot s-wind', visibility: 'hidden' });
    windSvg.append(crossW, dotW, dotG);
    rainSvg.append(crossR);

    st.geom = { x, wy, width, crossW, crossR, dotG, dotW, colEls, cols };
    if (st.active != null) setActive(st.active, { announce: false });
  }

  function clampX(xx, width) {
    return Math.min(width - M.right - 22, Math.max(M.left + 22, xx));
  }

  // --- interaction -----------------------------------------------------------
  function indexAt(clientX) {
    const rect = charts.getBoundingClientRect();
    const px = clientX - rect.left;
    const { width } = st.geom;
    const plotW = width - M.left - M.right;
    const ms = t0 + ((px - M.left) / plotW) * (t1 - t0);
    const i = Math.round((ms - rows[0].time.getTime()) / HOUR);
    return Math.max(0, Math.min(rows.length - 1, i));
  }

  function tooltipContent(r) {
    const row = (cls, kind, value, label) =>
      h('li', {}, h('span', { class: `key key-${kind} ${cls}`, 'aria-hidden': 'true' }), h('strong', { text: value }), h('span', { text: label }));
    return [
      h('p', { class: 'tt-time', text: formatDateTime(r.time) }),
      h(
        'ul',
        {},
        row('s-gust', 'line', formatWind(r.raw.windGusts), t('chart.gusts')),
        row('s-wind', 'line', formatWind(r.raw.windSpeed), t('chart.wind')),
        row('s-rain', 'rect', formatRain(r.raw.precipitation), t('chart.rain')),
        r.prob != null ? h('li', { class: 'tt-extra' }, h('span', { class: 'key', 'aria-hidden': 'true' }), h('strong', { text: formatPercent(r.prob) }), h('span', { text: t('chart.chance') })) : null,
      ),
    ];
  }

  let liveTimer = 0;
  function setActive(i, { announce = true } = {}) {
    st.active = i;
    const g = st.geom;
    if (!g) return;
    const r = rows[i];
    const xx = Math.round(g.x(r.time.getTime())) + 0.5;
    for (const line of [g.crossW, g.crossR]) {
      line.setAttribute('x1', xx);
      line.setAttribute('x2', xx);
      line.setAttribute('visibility', 'visible');
    }
    const place = (dot, v) => {
      if (isNum(v)) {
        dot.setAttribute('cx', xx);
        dot.setAttribute('cy', g.wy(v));
        dot.setAttribute('visibility', 'visible');
      } else dot.setAttribute('visibility', 'hidden');
    };
    place(g.dotG, r.gust);
    place(g.dotW, r.wind);
    g.cols.classList.add('is-hovering');
    g.colEls.forEach((el, k) => el?.classList.toggle('is-active', k === i));

    fill(tooltip, tooltipContent(r));
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth || 180;
    const left = xx + 14 + tw > g.width ? Math.max(0, xx - 14 - tw) : xx + 14;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = '28px';

    if (announce) {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(() => {
        live.textContent = t('chart.announce', { time: formatDateTime(r.time), gust: formatWind(r.raw.windGusts), wind: formatWind(r.raw.windSpeed), rain: formatRain(r.raw.precipitation) });
      }, 250);
    }
  }

  function clearActive() {
    st.active = null;
    const g = st.geom;
    if (!g) return;
    for (const el of [g.crossW, g.crossR, g.dotG, g.dotW]) el.setAttribute('visibility', 'hidden');
    g.cols.classList.remove('is-hovering');
    g.colEls.forEach((el) => el?.classList.remove('is-active'));
    tooltip.hidden = true;
  }

  const onMove = (ev) => {
    if (!st.geom) return;
    setActive(indexAt(ev.clientX), { announce: false });
  };
  const onLeave = () => {
    if (document.activeElement !== charts) clearActive();
  };
  const nowIndex = () => {
    let best = 0;
    rows.forEach((r, i) => {
      if (Math.abs(r.time - now) < Math.abs(rows[best].time - now)) best = i;
    });
    return best;
  };
  const onKey = (ev) => {
    const last = rows.length - 1;
    let i = st.active ?? nowIndex();
    if (ev.key === 'ArrowRight') i = Math.min(last, (st.active == null ? i - 1 : i) + (ev.shiftKey ? 6 : 1));
    else if (ev.key === 'ArrowLeft') i = Math.max(0, (st.active == null ? i + 1 : i) - (ev.shiftKey ? 6 : 1));
    else if (ev.key === 'Home') i = 0;
    else if (ev.key === 'End') i = last;
    else if (ev.key === 'Escape') {
      clearActive();
      return;
    } else return;
    ev.preventDefault();
    setActive(i);
  };
  const onFocus = () => {
    if (st.active == null) setActive(nowIndex());
  };
  const onBlur = () => clearActive();

  charts.addEventListener('pointermove', onMove);
  charts.addEventListener('pointerdown', onMove);
  charts.addEventListener('pointerleave', onLeave);
  charts.addEventListener('keydown', onKey);
  charts.addEventListener('focus', onFocus);
  charts.addEventListener('blur', onBlur);

  let ro = null;
  let raf = 0;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const w = Math.floor(charts.clientWidth);
        if (w && Math.abs(w - st.width) >= 2 && !charts.hidden) draw();
      });
    });
    ro.observe(charts);
  }
  st.cleanup = () => {
    ro?.disconnect();
    cancelAnimationFrame(raf);
    clearTimeout(liveTimer);
  };

  if (!showTable) draw();
  else {
    // Draw once the charts become visible again.
    st.width = 0;
  }
}

/** Keep the current render but mark it as updating (held at reduced opacity by CSS). */
export function setChartsBusy(container, busy) {
  container?.classList.toggle('is-refreshing', Boolean(busy));
}
