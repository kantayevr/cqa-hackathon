const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { MODEL, evaluateConversation } = require('./evaluate-one');
const { defaultChecklist, calculateScore } = require('./score');

const sizes = { dev: 65, prod: 10 };

function saveJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');	
  renameSync(temp, file);
}

async function evaluateInParts(record) {
  const middle = Math.ceil(defaultChecklist.length / 2);
  const first = await evaluateConversation(record, defaultChecklist.slice(0, middle));
  const second = await evaluateConversation(record, defaultChecklist.slice(middle));

  const criteria = [...first.criteria, ...second.criteria];
  const answers = Object.fromEntries(
    criteria.map(({ criterion_id, value }) => [criterion_id, value])
  );

  return {
    ...first,
    criteria,
    score: calculateScore(defaultChecklist, answers),
  };
}

async function main() {
  const [group, teamArg] = process.argv.slice(2);
  const teamName = teamArg?.trim();

  if (!Object.hasOwn(sizes, group) || !teamName) {
    throw new Error('Пример запуска: node evaluate-batch.js dev "Название команды"');
  }

  const dataDir = join(__dirname, 'data');
  const input = readFileSync(join(dataDir, `${group}.json`), 'utf8');
  const dataset = JSON.parse(input);
  const records = dataset.data?.records;

  if (dataset.isSuccess !== true || !Array.isArray(records) || records.length !== sizes[group]) {
    throw new Error(`Для ${group} ожидается ${sizes[group]} диалогов из API`);
  }

  const ids = records.map((record) => record.conversation_id);
  if (ids.some((id) => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error('Во входных данных есть пустые или повторяющиеся conversation_id');
  }

  const signature = createHash('sha256')
    .update(input)
    .update(JSON.stringify([MODEL, teamName]))
    .update(readFileSync(join(__dirname, 'checklist.json')))
    .update(readFileSync(join(__dirname, 'score.js')))
    .update(readFileSync(join(__dirname, 'evaluate-one.js')))
    .digest('hex');

  const checkpoint = join(dataDir, `${group}-progress.json`);
  const saved = existsSync(checkpoint) ? JSON.parse(readFileSync(checkpoint, 'utf8')) : null;
  let previous = saved?.signature === signature ? saved.results : [];

  if (process.argv.includes('--retry-errors') && saved?.signature !== signature) {
    const reportPath = join(__dirname, 'results', group, 'results.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const reportIds = new Set(report.results.map((result) => result.conversation_id));

    if (report.team_name !== teamName || report.model?.name !== MODEL ||
        report.results.length !== ids.length || !ids.every((id) => reportIds.has(id))) {
      throw new Error('Отчёт не совпадает с текущим набором, командой или моделью');
    }

    previous = report.results;
  }
  const byId = new Map(previous.map((result) => [result.conversation_id, result]));

  for (const [index, record] of records.entries()) {
    const id = record.conversation_id;
    if (byId.get(id)?.status === 'ok') continue;

    console.log(`[${index + 1}/${records.length}] ${id}`);

    let result;
    try {
      result = process.argv.includes('--retry-errors')
        ? await evaluateInParts(record)
  	: await evaluateConversation(record);
    } catch (error) {
      result = {
        conversation_id: id,
        status: 'error',
        criteria: [],
        score: null,
        error: error.message,
      };
      console.error(`  Ошибка: ${error.message}`);
    }

    byId.set(id, result);
    saveJson(checkpoint, { signature, results: [...byId.values()] });
  }

  const results = ids.map((id) => byId.get(id));
  const outputDir = join(__dirname, 'results', group);
  mkdirSync(outputDir, { recursive: true });
  saveJson(join(outputDir, 'results.json'), {
    schema_version: '1.0',
    team_name: teamName,
    model: { mode: 'local', name: MODEL },
    results,
  });

  const errors = results.filter((result) => result.status === 'error').length;
  console.log(`Сохранено results/${group}/results.json. Записей: ${results.length}. Ошибок: ${errors}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});