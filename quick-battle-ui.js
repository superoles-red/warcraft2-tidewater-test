import {readJson} from './map-renderer.js';
import {translate as t} from './localization.js';

const baseOptions = {
  race:'random', opponents:null, resources:'mapDefault', terrain:'mapDefault',
  oneWorker:false, fixedStarts:false, fog:true,
};
const choices = [
  ['race', 'Race', [['mapDefault','Map default'], ['human','Human'], ['orc','Orc'], ['random','Random']]],
  ['opponents', 'Opponents', [[null,'Map default'], ...Array.from({length:7}, (_, i) => [i + 1, String(i + 1)])]],
  ['resources', 'Resources', [['mapDefault','Map default'], ['low','Low'], ['medium','Medium'], ['high','High'], ['random','Random']]],
  ['terrain', 'Terrain', [['mapDefault','Map default'], ['forest','Forest'], ['winter','Winter'],
    ['wasteland','Wasteland'], ['swamp','Swamp'], ['random','Random']]],
  ['oneWorker', 'Starting units', [[false,'Map default'], [true,'One worker']]],
];
let catalogPromise;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function uncheckedSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

export async function openQuickBattle({
  show, control, confirm, dismiss, back, load, resume, active, complete, fog, stop,
}) {
  try {
    catalogPromise ??= readJson('./scenarios/catalog.json').catch(error => {
      catalogPromise = undefined;
      throw error;
    });
    const catalog = await catalogPromise;
    let selected = catalog.maps.find(map => map.id === resume?.id) || catalog.maps[0];
    if (!selected) throw new Error(t('Choose a scenario'));
    let options = resume ? {...baseOptions, ...resume.options} : {...baseOptions, fog: fog()};
    let category = '';
    let size = '';
    let expanded = new Set();
    const orientation = matchMedia('(orientation: landscape)');
    let list;

    function close() {
      orientation.removeEventListener('change', fillMaps);
      back();
    }

    function settings() {
      orientation.removeEventListener('change', fillMaps);
      const fields = element('div', null, 'quick-fields');
      for (const [key, label, variants] of choices) {
        const field = element('div', null, 'quick-field');
        const value = variants.find(([value]) => options[key] === value)?.[1] ?? 'Map default';
        field.append(element('span', t(label)), control(t(value), () => {
          confirm(label, [], [
            ...variants.map(([next, text]) => [text, () => {
              options = {...options, [key]:next};
              dismiss();
              settings();
            }, options[key] === next ? 'current-choice' : '']),
            ['Back', dismiss, 'negative'],
          ], {layout:'scenario-options'});
        }, {raw:true, dropdown:true}));
        fields.append(field);
      }
      const position = element('label', null, 'check-control');
      const fixed = document.createElement('input');
      fixed.type = 'checkbox';
      fixed.checked = options.fixedStarts;
      fixed.addEventListener('change', () => { options = {...options, fixedStarts:fixed.checked}; });
      position.append(fixed, t('Fixed starting positions'));
      fields.append(position);
      const details = element('div', null, 'quick-details');
      details.append(fields, element('p', selected.title, 'quick-map-title'));
      const actions = element('div', null, 'quick-actions');
      actions.append(
        control('Select Scenario', chooseScenario),
        control('Start Game', () => offerStart(false), {tone:'positive'}),
      );
      show('quick', 'Custom Scenario', [details, actions], close);
    }

    function filter(label, values, current, set) {
      const box = element('details', null, 'scenario-filter');
      const summary = element('summary', t(values.find(([value]) => value === current)?.[1] ?? label), 'war-button');
      const popup = element('div', null, 'scenario-filter-menu');
      summary.setAttribute('aria-label', t(label));
      for (const [value, name] of values) {
        const option = control(name, () => set(value));
        if (value === current) option.setAttribute('aria-current', 'true');
        popup.append(option);
      }
      box.append(summary, popup);
      return box;
    }

    function chooseScenario() {
      const previous = {selected, category, size, expanded:new Set(expanded)};
      scenarios(() => {
        ({selected, category, size, expanded} = previous);
        settings();
      });
    }

    function scenarios(cancel) {
      const filters = element('div', null, 'scenario-filters');
      const sizeOf = map => `${map.width}×${map.height}`;
      const sizes = [...new Set(catalog.maps.map(sizeOf))].sort((a,b) => Number(a.split('×')[0]) - Number(b.split('×')[0]));
      filters.append(
        filter('All categories', [['','All categories'], ...catalog.categories.map(group => [group.id,group.title])],
          category, value => { category = value; scenarios(cancel); }),
        filter('Any size', [['','Any size'], ...sizes.map(value => [value,value])], size, value => { size = value; scenarios(cancel); }),
      );
      for (const dropdown of filters.children) {
        dropdown.querySelector('summary').addEventListener('click', () => {
          for (const other of filters.children) if (other !== dropdown) other.open = false;
        });
      }
      list = element('div', null, 'scenario-list');
      const maps = matchingMaps();
      if (!maps.some(map => map.id === selected.id) && maps.length) selected = maps[0];
      show('scenarios', 'Select Scenario', [filters, list], null,
        control('OK', settings, {tone:'positive', disabled: !maps.length}),
        control('Cancel', cancel, {tone:'negative'}));
      orientation.addEventListener('change', fillMaps);
      fillMaps();
    }

    function matchingMaps() {
      return catalog.maps.filter(map => (!category || map.category === category) &&
        (!size || `${map.width}×${map.height}` === size));
    }

    function fillMaps() {
      const maps = matchingMaps();
      if (!maps.length) {
        list.replaceChildren(element('p', t('No scenarios match these filters.'), 'scenario-empty'));
        return;
      }
      const landscape = orientation.matches;
      const colCount = landscape ? 2 : 1;
      const columns = Array.from({length:colCount}, () => element('div', null, 'scenario-column'));
      list.replaceChildren(...columns);
      for (const [index, map] of maps.entries()) {
        const card = element('div', null, 'scenario-card');
        const details = element('div', null, 'scenario-details');
        details.hidden = !expanded.has(map.id);
        const header = control(map.title, () => {
          selected = map;
          for (const other of list.querySelectorAll('.scenario-card.selected')) other.classList.remove('selected');
          card.classList.add('selected');
          if (expanded.has(map.id)) expanded.delete(map.id);
          else expanded.add(map.id);
          details.hidden = !expanded.has(map.id);
          card.classList.toggle('open', !details.hidden);
          header.setAttribute('aria-expanded', String(!details.hidden));
          if (!details.hidden) loadDetails();
        }, {raw:true});
        header.dataset.scenario = map.id;
        header.setAttribute('aria-expanded', String(!details.hidden));
        card.classList.toggle('selected', selected.id === map.id);
        card.classList.toggle('open', !details.hidden);
        function loadDetails() {
          if (details.children.length) return;
          const picture = element('img');
          picture.alt = '';
          picture.src = map.minimap;
          picture.addEventListener('error', () => picture.remove(), {once:true});
          const copy = element('div');
          copy.append(element('div', `${map.width} × ${map.height} · ${map.players} ${t('players')}`));
          if (map.era) copy.append(element('div', t(map.era)));
          if (map.description && map.description !== map.title) copy.append(element('p', map.description));
          details.append(picture, copy);
        }
        if (!details.hidden) loadDetails();
        card.append(header, details);
        columns[index % colCount].append(card);
      }
    }

    function offerStart(continuing) {
      const warning = !continuing && active() ? 'The previous battle will be replaced.' : '';
      confirm(continuing ? 'Continue the game?' : 'Start a new game?', [
        element('p', t('Custom Scenario')), element('p', selected.title, 'accent'),
        ...(warning ? [element('p', t(warning), 'warning')] : []),
      ], [
        [continuing ? 'Continue' : 'Start', async () => {
          dismiss();
          show('loading', 'Loading mission…', []);
          try {
            const result = await load(selected, {...options, seed: continuing ? options.seed : uncheckedSeed()}, continuing);
            complete({id:selected.id, title:selected.title, options:{...result.scenario.options, seed:result.scenario.seed}});
            stop();
          } catch (error) {
            show('loading', 'Unable to load the mission', [element('p',error.message)], settings);
          }
        }, 'positive'],
        ['Back', dismiss, 'negative'],
      ], {layout:'battle-confirmation'});
    }
    if (resume && selected.id === resume.id) offerStart(true);
    else settings();
  } catch (error) {
    confirm('Unable to load the mission', [element('p', error.message)], [['Back', dismiss, 'negative']]);
  }
}
