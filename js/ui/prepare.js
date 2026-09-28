// "Be prepared" checklist (progress saved on this device), emergency
// contacts as tap-to-call buttons, and the official source links.

import { CHECKLIST, EMERGENCY_CONTACTS, OFFICIAL_SOURCES, SURGE_TOWNSHIPS } from '../config.js';
import { formatNumber, getLang, hasKey, localDigits, t } from '../i18n.js';
import { extLink, fill, h, icon } from './dom.js';
import { listFormat } from './status.js';

const CHECK_KEY = 'ysw.checklist.v1';
const ALL_IDS = CHECKLIST.flatMap((g) => g.ids);

function loadChecked() {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(CHECK_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((id) => ALL_IDS.includes(id)) : []);
  } catch {
    return new Set();
  }
}

function saveChecked(set) {
  try {
    globalThis.localStorage?.setItem(CHECK_KEY, JSON.stringify([...set]));
  } catch {
    /* progress just is not remembered */
  }
}

const tOr = (key, fallback) => (hasKey(key) ? t(key) : fallback);

/** @param {HTMLElement} el #prepare-body */
export function renderChecklist(el) {
  const checked = loadChecked();
  const progressText = h('p', { class: 'check-count', 'aria-live': 'polite' });
  const meterFill = h('span', { class: 'meter-fill' });
  const meter = h('span', { class: 'meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(ALL_IDS.length) }, meterFill);
  const boxes = [];

  const update = () => {
    const n = ALL_IDS.filter((id) => checked.has(id)).length;
    progressText.textContent = t('check.progress', { done: formatNumber(n), total: formatNumber(ALL_IDS.length) });
    meter.setAttribute('aria-valuenow', String(n));
    meter.setAttribute('aria-label', progressText.textContent);
    meterFill.style.width = `${(n / ALL_IDS.length) * 100}%`;
  };

  const groups = CHECKLIST.map((g) =>
    h(
      'fieldset',
      { class: 'check-group' },
      h('legend', { text: t(`check.group.${g.group}`) }),
      h(
        'ul',
        {},
        g.ids.map((id) => {
          const box = h('input', { type: 'checkbox', id: `chk-${id}`, dataset: { id } });
          box.checked = checked.has(id);
          box.addEventListener('change', () => {
            if (box.checked) checked.add(id);
            else checked.delete(id);
            saveChecked(checked);
            update();
          });
          boxes.push(box);
          return h('li', {}, h('label', { for: `chk-${id}`, class: 'check-item' }, box, h('span', { text: t(`check.${id}`) })));
        }),
      ),
    ),
  );

  // "Start again" clears the ticks but offers an Undo for a while (a slip of
  // the finger must not wipe saved progress).
  const undoLine = h('p', { class: 'check-undo', role: 'status', hidden: true });
  let undoTimer = 0;
  const hideUndo = () => {
    clearTimeout(undoTimer);
    undoLine.hidden = true;
    undoLine.replaceChildren();
  };
  const reset = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-quiet btn-sm',
      on: {
        click: () => {
          const prev = [...checked];
          if (!prev.length) return;
          checked.clear();
          saveChecked(checked);
          for (const b of boxes) b.checked = false;
          update();
          const undo = h(
            'button',
            {
              type: 'button',
              class: 'btn btn-secondary btn-sm',
              on: {
                click: () => {
                  for (const id of prev) checked.add(id);
                  saveChecked(checked);
                  for (const b of boxes) b.checked = checked.has(b.dataset.id);
                  update();
                  hideUndo();
                  reset.focus();
                },
              },
            },
            h('span', { text: t('check.undo') }),
          );
          undoLine.replaceChildren(h('span', { text: t('check.cleared', { n: formatNumber(prev.length) }) }), ' ', undo);
          undoLine.hidden = false;
          clearTimeout(undoTimer);
          undoTimer = setTimeout(hideUndo, 15000);
        },
      },
    },
    icon('reset', { size: 18 }),
    h('span', { text: t('check.reset') }),
  );
  for (const b of boxes) b.addEventListener('change', hideUndo);

  const townships = SURGE_TOWNSHIPS.map((name) => tOr(`township.${name}`, name));
  fill(
    el,
    h('p', { class: 'section-intro', text: t('prepare.intro') }),
    h('div', { class: 'check-progress' }, progressText, meter, reset, undoLine),
    h('div', { class: 'check-groups' }, groups),
    h(
      'aside',
      { class: 'note-card note-surge', 'aria-labelledby': 'surge-title' },
      h('h3', { id: 'surge-title' }, icon('surge', { size: 22 }), h('span', { text: t('prepare.surge.title') })),
      h('p', { text: t('prepare.surge.body') }),
      h('p', { class: 'surge-towns' }, h('strong', { text: `${t('prepare.surge.townships')} ` }), h('span', { text: listFormat(townships) })),
      h('p', { text: t('prepare.surge.action') }),
    ),
    h(
      'aside',
      { class: 'note-card', 'aria-labelledby': 'radio-title' },
      h('h3', { id: 'radio-title' }, icon('radio', { size: 22 }), h('span', { text: t('prepare.radio.title') })),
      h('p', { text: t('prepare.radio.body') }),
      h('p', { class: 'muted', text: t('prepare.shelter') }),
    ),
  );
  update();
}

/** @param {HTMLElement} el #contacts-body */
export function renderContacts(el) {
  fill(
    el,
    h(
      'ul',
      { class: 'tel-list' },
      EMERGENCY_CONTACTS.map((c) =>
        h(
          'li',
          {},
          h(
            'a',
            { class: 'tel-btn', href: `tel:${c.tel}` },
            icon('phone', { size: 22 }),
            h('span', { class: 'tel-num', text: localDigits(c.number) }),
            h('span', { class: 'tel-label', text: t(c.key) }),
          ),
          c.noteKey ? h('p', { class: 'tel-note', text: t(c.noteKey) }) : null,
        ),
      ),
    ),
    h('p', { class: 'note-inline' }, icon('info', { size: 18 }), h('span', { text: t('contacts.shortCodes') })),
    h('p', { class: 'note-inline' }, icon('info', { size: 18 }), h('span', { text: t('contacts.abroad') })),
  );
}

/** @param {HTMLElement} el #sources-body */
export function renderSources(el) {
  const lang = getLang();
  fill(
    el,
    h(
      'ul',
      { class: 'source-list' },
      OFFICIAL_SOURCES.map((s) =>
        h(
          'li',
          {},
          extLink(lang === 'my' ? s.urlMy : s.urlEn, t(s.key)),
          s.official ? h('span', { class: 'badge badge-official', text: t('sources.official') }) : null,
          s.noteKey ? h('p', { class: 'muted small', text: t(s.noteKey) }) : null,
        ),
      ),
    ),
  );
}
