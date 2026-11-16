const oldCampaigns = {
  human: 'human-tod',
  orc: 'orc-tod',
  xhuman: 'human-btdp',
  xorc: 'orc-btdp',
};

const labels = {
  en: {
    files: 'Files', download: 'Export Save', upload: 'Import Save', source: 'Source Code',
    details: 'Campaign progress and selected mission. The mission will start from the beginning.',
    confirm: 'Import this save?', back: 'Back',
    warning: 'This replaces the campaign progress and selected mission in Tidewater.',
    fast: 'The file includes a quick battle. Only its campaign progress will be imported.',
    success: 'Campaign progress imported.', error: 'The save file could not be read or stored.',
    exportError: 'The save file could not be exported.',
  },
  ru: {
    files: 'Файлы', download: 'Экспорт сохранения', upload: 'Импорт сохранения', source: 'Исходный код',
    details: 'Прогресс кампаний и выбранная миссия. Миссия начнётся заново.',
    confirm: 'Импортировать сохранение?', back: 'Назад',
    warning: 'Прогресс кампаний и выбранная миссия в Tidewater будут заменены.',
    fast: 'В файле есть быстрый бой. Будет перенесён только прогресс кампаний.',
    success: 'Прогресс кампаний перенесён.', error: 'Не удалось прочитать или записать файл сохранения.',
    exportError: 'Не удалось экспортировать сохранение.',
  },
};

const codec = async () => {
  await Promise.all([import('./lib/legacy-session.js'), import('./lib/legacy-files.js')]);
  return {files: globalThis.WarcraftFiles, session: globalThis.WarcraftSession};
};

function chooseFile(onFile) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.hidden = true;
  input.addEventListener('change', () => {
    input.remove();
    if (input.files[0]) onFile(input.files[0]);
  }, {once: true});
  input.addEventListener('cancel', () => input.remove(), {once: true});
  document.body.append(input);
  input.click();
}

function download({text, filename}) {
  const url = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function openFiles({confirm, dismiss, back, progress, campaigns}) {
  const label = labels[document.documentElement.lang] ?? labels.en;
  const paragraph = (message, tone) => {
    const node = document.createElement('p');
    node.textContent = message;
    if (tone) node.classList.add(tone);
    return node;
  };
  const close = () => { dismiss(); back(); };

  async function exportFile() {
    try {
      const {files, session} = await codec();
      const saved = progress.exportProgress();
      const completed = Object.fromEntries(campaigns.map(campaign => {
        const prefix = campaign.missions.findIndex(mission => !saved.completed.includes(mission.id));
        const missions = campaign.missions.slice(0, prefix === -1 ? undefined : prefix);
        return [oldCampaigns[campaign.id], missions.map(mission => mission.number)];
      }));
      const campaign = campaigns.find(item => item.missions.some(mission => mission.id === saved.last));
      const mission = campaign?.missions.find(item => item.id === saved.last);
      const slot = mission ? {kind: 'campaign', campaign: oldCampaigns[campaign.id], mission: mission.number} : null;
      download(await files.makeFile({completed, slot}, session));
    } catch { show(label.exportError); }
  }

  async function importFile(file) {
    try {
      if (file.size > 16 * 1024) throw new Error();
      const {files, session} = await codec();
      const record = await files.readFile(await file.text(), session, () => true);
      const campaign = campaigns.find(item => oldCampaigns[item.id] === record.slot?.campaign);
      const next = {
        completed: campaigns.flatMap(item => item.missions
          .filter(mission => record.completed[oldCampaigns[item.id]].includes(mission.number))
          .map(mission => mission.id)),
        last: campaign?.missions.find(mission => mission.number === record.slot.mission)?.id ?? null,
        recent: campaign?.id ?? null,
      };
      const message = record.slot?.kind === 'fast' ? label.fast : label.details;
      confirm(label.confirm, [paragraph(message), paragraph(label.warning, 'warning')], [
        [label.upload, () => show(progress.importProgress(next) ? label.success : label.error), 'positive', true],
        [label.back, () => show(), 'negative', true],
      ]);
    } catch { show(label.error); }
  }

  function show(status) {
    confirm(label.files, [paragraph(label.details), ...(status ? [paragraph(status)] : [])], [
      [label.download, exportFile, 'positive', true],
      [label.upload, () => chooseFile(importFile), '', true],
      [label.source, () => window.open('./SOURCE.md', '_blank', 'noopener'), '', true],
      [label.back, close, 'negative', true],
    ]);
  }

  show();
}
