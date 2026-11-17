const TABLES = {
  en: './art/results/results.json',
  ru: './art/results/ru/results.json',
};

const COPY = {
  en: {
    outcome: 'Outcome', victory: 'Victory!', defeat: 'Defeat!', rank: 'Rank', score: 'Score',
    victoryPrompt: ['Congratulations!', 'You are victorious!'],
    defeatPrompt: ['You failed to', 'achieve victory!'],
    victoryButton: 'Victory', defeatButton: 'OK', continue: 'Continue', menu: 'Main Menu',
    stats: ['Units', 'Buildings', 'Gold', 'Lumber', 'Oil', 'Kills', 'Razings'],
  },
  ru: {
    outcome: 'Результат', victory: 'Победа!', defeat: 'Поражение!', rank: 'Звание', score: 'Очки',
    victoryPrompt: ['Поздравляем!', 'Вы победитель!'],
    defeatPrompt: ['Вы проиграли', 'в этой битве!'],
    victoryButton: 'Победа', defeatButton: 'ОК', continue: 'Далее', menu: 'В главное меню',
    stats: ['Юниты', 'Строения', 'Золото', 'Дерево', 'Нефть', 'Убито', 'Разрушено'],
  },
};

const COLORS = ['#a40000', '#003cc0', '#2cb494', '#9848b0', '#f88c14', '#38384d', '#e0e0e0', '#fcfc48'];
const THRESHOLDS = [2000, 5000, 8000, 18000, 28000, 40000, 55000, 70000, 85000,
  105000, 125000, 145000, 165000, 185000, 205000, 230000, 255000, 280000, 300000];
const tables = new Map();

function table(language) {
  if (!tables.has(language)) {
    const loading = fetch(TABLES[language]).then(response => {
      if (!response.ok) throw new Error('Result text is unavailable');
      return response.json();
    }).catch(() => {
      tables.delete(language);
      return language === 'en' ? {ranks:[], names:{}} : table('en');
    });
    tables.set(language, loading);
  }
  return tables.get(language);
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label, onClick, alternate = false) {
  const element = node('button', 'war-button ' + (alternate ? 'negative result-menu' : 'positive'), label);
  element.type = 'button';
  element.addEventListener('click', onClick);
  return element;
}

function heading(label, className, value) {
  const block = node('div', className);
  block.append(node('span', 'result-caption', label), value);
  return block;
}

function statField(label, color) {
  const value = node('dd', 'result-meter');
  const fill = node('span', 'result-meter-fill');
  fill.style.backgroundColor = color;
  const number = node('span', 'result-meter-number', '0');
  value.append(fill, number);
  const group = node('div', 'result-field');
  group.append(node('dt', null, label), value);
  return {group, update(shown, maximum) {
    fill.style.width = (maximum ? shown * 100 / maximum : 0) + '%';
    number.textContent = String(shown);
  }};
}

export function showResults({
  world, won, language = 'en', onAdvance, onMenu, musicVolume = 0,
  routeMedia, onClick, onSound, onMediaChange,
}) {
  const locale = language === 'ru' ? 'ru' : 'en';
  const copy = COPY[locale];
  const result = won ? 'victory' : 'defeat';
  const orc = world.race === 1 || world.race === 'orc';
  const race = orc ? 'orc' : 'human';
  const art = './art/results/' + race + '-' + result;
  const record = world.score;
  const total = record?.totalScore ?? ((record?.score ?? 0) + (won ? 500 : 0));
  const rows = record?.rows ?? [];
  const rankIndex = THRESHOLDS.findIndex(limit => total < limit);
  const rankEntry = record?.rankEntry ?? ((rankIndex < 0 ? 18 : rankIndex) * 2 + (orc ? 2 : 1));
  const originalText = table(locale);
  const artImage = node('img', 'result-art');
  artImage.src = art + '.webp';
  artImage.alt = '';
  artImage.width = 640;
  artImage.height = 480;
  const dialog = node('dialog', 'warcraft-results');
  dialog.dataset.race = race;
  dialog.dataset.stage = 'outcome';
  dialog.setAttribute('aria-label', copy[result]);
  let music;
  let releaseMusic;
  let primary;
  let timer;
  let closed = false;

  function audioVisibility() {
    if (document.hidden) music?.pause();
    else if (music && !music.ended) music.play().catch(() => {});
  }

  function close(next) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    music?.pause();
    releaseMusic?.();
    document.removeEventListener('visibilitychange', audioVisibility);
    dialog.close();
    dialog.remove();
    onMediaChange?.('closed');
    next?.();
  }

  function statistics() {
    if (closed || dialog.dataset.stage === 'statistics') return;
    dialog.dataset.stage = 'statistics';
    onMediaChange?.('statistics');
    if (musicVolume > 0) {
      music = new Audio(art + '.m4a');
      if (routeMedia) releaseMusic = routeMedia(music, 'music');
      else music.volume = Math.min(1, musicVolume);
      music.play().catch(() => {});
      document.addEventListener('visibilitychange', audioVisibility);
    }

    const outcome = node('h1', 'result-word');
    const title = node('img', 'result-word-image');
    title.src = new URL(result + '-word.webp', new URL(TABLES[locale], document.baseURI));
    title.alt = copy[result];
    title.addEventListener('error', () => { outcome.textContent = copy[result]; }, {once:true});
    outcome.append(title);
    const rank = node('strong', 'result-rank-value', '—');
    const score = node('strong', 'result-score-value', '0');
    const summary = node('header', 'result-summary');
    summary.append(heading(copy.outcome, 'result-outcome', outcome),
      heading(copy.rank, 'result-rank', rank), heading(copy.score, 'result-score', score));

    const max = copy.stats.map((_, stat) => Math.max(0, ...rows.map(row => row.values[stat])));
    const fields = [];
    const names = [];
    const standings = node('div', 'result-standings');
    for (const row of rows) {
      const player = node('section', 'result-player');
      const name = node('h2', 'result-player-name', '—');
      const measurements = node('dl', 'result-fields');
      const color = COLORS[row.color ?? row.colour ?? row.slot] || '#aa925f';
      const meters = copy.stats.map((label, index) => {
        const meter = statField(label, color);
        measurements.append(meter.group);
        return shown => meter.update(shown, max[index]);
      });
      fields.push({values: row.values, meters});
      names.push({name, row});
      player.append(name, measurements);
      standings.append(player);
    }

    primary = button(copy.continue, () => { onClick?.(); close(onAdvance ?? onMenu); });
    const actions = node('footer', 'result-actions');
    actions.append(primary);
    if (onAdvance && onMenu) {
      actions.append(button(copy.menu, () => { onClick?.(); close(onMenu); }, true));
    }
    const content = node('div', 'result-content');
    const records = node('section', 'result-records');
    records.append(summary, standings);
    content.append(artImage, records, actions);
    dialog.replaceChildren(content);
    primary.focus();

    let rankText = '—';
    let rankRevealed = false;
    originalText.then(text => {
      rankText = text.ranks[rankEntry - 1] || '—';
      if (rankRevealed) rank.textContent = rankText;
      for (const entry of names) {
        const label = text.names[entry.row.label];
        const player = text.names[entry.row.nameEntry] || entry.row.name;
        entry.name.textContent = [player, label].filter(Boolean).join(' - ') || '—';
      }
    });

    function finish() {
      rankRevealed = true;
      rank.textContent = rankText;
      score.textContent = String(total);
    }

    const step = max.map(value => Math.max(1, Math.floor(value / 40)));
    const barsDone = Math.max(0, ...max.map((value, index) => Math.ceil(value / step[index])));
    const scoreStep = Math.floor(total / 10);
    const scoreDone = scoreStep ? Math.ceil(total / scoreStep) : 0;
    function updateBars(ticks) {
      for (const {values, meters} of fields) {
        meters.forEach((paint, index) => paint(Math.min(values[index], step[index] * ticks)));
      }
    }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      updateBars(barsDone);
      finish();
    } else {
      const started = performance.now();
      let scoreStarted = false;
      function count() {
        const ticks = Math.floor((performance.now() - started) / 40);
        updateBars(ticks);
        if (ticks >= barsDone) {
          if (!scoreStarted) {
            scoreStarted = true;
            onSound?.('result-numbers');
          }
          if (ticks >= barsDone + scoreDone) {
            finish();
            onSound?.('result-rank');
            return;
          }
          score.textContent = String(Math.min(total, (ticks - barsDone) * scoreStep));
        }
        timer = setTimeout(count, 40);
      }
      timer = setTimeout(count, 40);
    }
  }

  const prompt = node('section', 'result-prompt');
  const announcement = node('h1');
  announcement.append(node('span', null, copy[result + 'Prompt'][0]),
    node('span', null, copy[result + 'Prompt'][1]));
  primary = button(copy[result + 'Button'], () => { onClick?.(); statistics(); });
  primary.classList.toggle('result-ok', !won);
  prompt.append(announcement, primary);
  dialog.append(prompt);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    primary.click();
  });
  document.body.append(dialog);
  dialog.showModal();
  onMediaChange?.('outcome');
  return close;
}
