import {readJson} from './map-renderer.js';

const key = 'tidewater-language';
let language = 'en';
let data;
const russian = {
  'Human Campaign':'Кампания людей', 'Orc Campaign':'Кампания орков',
  'Tides of Darkness':'Приливы Тьмы', 'Beyond the Dark Portal':'За Тёмным Порталом',
  'Campaign':'Кампания', 'Settings':'Настройки', 'Continue':'Продолжить', 'Back':'Назад',
  'Play':'Играть', 'Start':'Начать', 'Menu':'Меню', 'Game Menu':'Игровое меню',
  'Main Menu':'Главное меню', 'Exit to Main Menu':'Выйти в меню', 'Restart':'Начать заново',
  'Restart the mission?':'Начать миссию заново?', 'Exit to the Main Menu?':'Выйти в главное меню?',
  'Progress in this battle will be replaced.':'Прогресс в этом сражении будет заменён.',
  'Progress in this battle will not be saved.':'Прогресс в этом сражении не сохранится.',
  'The previous battle will be replaced.':'Предыдущая игра будет заменена.',
  'This mission will start again.':'Миссия начнётся заново.',
  'Continue the game?':'Продолжить игру?', 'Start a new game?':'Начать новую игру?',
  'Objectives':'Цели миссии', 'Mission Objectives':'Цели миссии', 'Show every time':'Показывать каждый раз',
  'Sound':'Звук', 'Music':'Музыка', 'Sound effects':'Эффекты', 'Fog of war':'Туман войны',
  'Game speed':'Скорость игры', 'Slow':'Медленно', 'Medium':'Средне', 'Fast':'Быстро',
  'OK':'ОК', 'Cancel':'Отмена', 'Place':'Поставить', 'Buy':'Купить',
  'Gold':'Золото', 'Lumber':'Дерево', 'Oil':'Нефть', 'Food':'Еда', 'Gold left':'Осталось золота',
  'Armor':'Броня', 'Damage':'Урон', 'Range':'Дальность', 'Sight':'Зрение', 'Speed':'Скорость', 'complete':'завершено',
  'Move':'Двигаться', 'Attack':'Атаковать', 'Stop':'Стоп', 'Repair':'Починить', 'Harvest':'Добывать',
  'Patrol':'Патрулировать', 'Stand ground':'Держать позицию', 'Return goods':'Доставить ресурсы',
  'Build Basic Structures':'Строить основные здания', 'Build Advanced Structures':'Строить особые здания',
  'Choose another site':'Выберите другое место', 'Choose a site, then tap Place':'Выберите место и нажмите «Поставить»',
  'Tap a target':'Нажмите на цель', 'Victory':'Победа', 'Defeat':'Поражение', 'Next Mission':'Следующая миссия',
  'Units defeated':'Убито врагов', 'Buildings destroyed':'Уничтожено строений', 'Units lost':'Потеряно бойцов',
  'Buildings lost':'Потеряно строений', 'Score':'Очки',
  'Language':'Язык', 'Delete Russian':'Удалить русский', 'Delete Russian?':'Удалить русский язык?',
  'Download language?':'Скачать язык?', 'MB of storage required':'МБ свободного места',
  'Download':'Скачать', 'Downloading language…':'Загрузка языка…', 'Delete':'Удалить',
  'Language unavailable':'Язык недоступен', 'Files':'Файлы', 'About the game':'Об игре', 'Update':'Обновить',
  'Checking for updates…':'Проверяем обновления…', 'Loading mission…':'Загрузка миссии…',
  'You have the latest version.':'Установлена последняя версия.',
  'The update is ready.':'Обновление готово.', 'Updates are unavailable right now.':'Не удалось проверить обновления.',
  'Humans':'Люди', 'Orcs':'Орки',
  'Unable to load the mission':'Не удалось открыть миссию', 'Quick Battle':'Быстрый бой',
  'Select Scenario':'Выбор сценария', 'All categories':'Все категории', 'Any size':'Любой размер',
  'Start Game':'Начать игру', 'Race':'Раса', 'Opponents':'Противники', 'Resources':'Ресурсы',
  'Terrain':'Местность', 'Starting units':'Начальные войска', 'Map default':'По умолчанию',
  'Human':'Люди', 'Orc':'Орки', 'Random':'Случайно', 'Low':'Мало', 'High':'Много',
  'Forest':'Лес', 'Winter':'Зима', 'Wasteland':'Пустошь', 'Swamp':'Болото',
  'One worker':'Один рабочий', 'Fixed starting positions':'Фиксированные стартовые позиции',
  'players':'игроков', 'Choose a scenario':'Выберите сценарий',
};

function preferred() {
  try { return localStorage.getItem(key) === 'ru' ? 'ru' : 'en'; }
  catch { return 'en'; }
}

export const currentLanguage = () => language;
export const translate = value => language === 'ru' ? russian[value] ?? data?.strings?.[value] ?? value : value;
export const unitLabel = (kind, fallback) => data?.units?.[kind] ?? translate(fallback);
export function commandLabel(command) {
  const value = language === 'ru' ? data?.stats?.[command.string] : null;
  if (typeof value === 'string' && /[А-ЯЁ]/i.test(value) && value.length > 2) {
    return value.replace(/^[a-z]/, '').replace(/\s*\([A-Z]?[0-9]*\)$/i, '').trim();
  }
  return translate(command.label);
}

export function missionLabel(mission) {
  return {...mission, ...data?.missions?.[mission.id]};
}

export async function setLanguage(value = preferred()) {
  const locale = value === 'ru' ? await readJson('./art/lang/ru/text.json') : null;
  data = locale;
  language = value;
  document.documentElement.lang = value;
  try { localStorage.setItem(key, value); } catch {}
}
