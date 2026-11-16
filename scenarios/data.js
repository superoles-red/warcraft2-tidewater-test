// Stock scenarios are fetched individually so the menu opens without downloading every map.
export async function readScenarioMap(entry) {
  const path = entry?.file;
  if (!/^\.\/scenarios\/maps\/(?:builtin-\d{4}|stock-\d{3})\.pud$/.test(path)) {
    throw new Error('Unknown scenario.');
  }
  const response = await fetch(path);
  if (!response.ok) throw new Error('Could not download the scenario.');
  const data = new Uint8Array(await response.arrayBuffer());
  // Reject, for example, an HTML fallback page returned by an offline server.
  if (data.length < 24 || data[0] !== 84 || data[1] !== 89 ||
      data[2] !== 80 || data[3] !== 69) {
    throw new Error('Invalid Warcraft II scenario.');
  }
  return data;
}
