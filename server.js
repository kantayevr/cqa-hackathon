const { createServer } = require('node:http');
const { existsSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { getActiveChecklist, saveActiveChecklist } = require('./checklist-store');
const { evaluateConversation } = require('./evaluate-one');
const { calculateScore } = require('./score');

const { data: { records } } = require('./data/dev.json');
const { results } = require('./results/dev/results.json');
const checklist = require('./checklist.json');
const page = readFileSync(join(__dirname, 'public', 'index.html'), 'utf8');

const conversations = new Map(records.map((item) => [item.conversation_id, item]));
const evaluations = new Map(results.map((item) => [item.conversation_id, item]));
const list = records.map(({ conversation_id, channel, language }) => ({
  conversation_id,
  channel,
  language,
}));

const uiFile = join(__dirname, 'data', 'ui-evaluations.json');
let uiEvaluations = existsSync(uiFile)
  ? new Map(JSON.parse(readFileSync(uiFile, 'utf8')))
  : new Map();
const running = new Set();

function saveUiEvaluation(id, entry) {
  const next = new Map(uiEvaluations);
  next.set(id, entry);

  const temp = `${uiFile}.tmp`;
  writeFileSync(temp, JSON.stringify([...next], null, 2) + '\n', 'utf8');
  renameSync(temp, uiFile);
  uiEvaluations = next;
}

function getReview(id) {
  return uiEvaluations.get(id) ?? {
    evaluation: evaluations.get(id) ?? null,
    checklist,
    appeals: [],
  };
}

function hasPendingAppeal(review) {
  return (review.appeals ?? []).some((appeal) => appeal.status === 'pending');
}

const sections = [
  ['Начало и понимание запроса', ['contact', 'discovery']],
  ['Безопасность и решение', ['identification', 'consultation']],
  ['Ведение и завершение диалога', ['empathy', 'dialogue', 'closure']],
];

function getSectionScores(review) {
  if (review.evaluation?.status !== 'ok') return [];

  const answers = Object.fromEntries(
    review.evaluation.criteria.map((item) => [item.criterion_id, item.value])
  );

  return sections.flatMap(([label, ids]) => {
    const rules = review.checklist.filter((rule) => ids.includes(rule.id));
    if (!rules.length) return [];

    const { final_score } = calculateScore(rules, answers);
    return [{ label, score: final_score }];
  });
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readRequestJson(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size <= 100_000) chunks.push(chunk);
  }

  if (size > 100_000) throw new Error('Запрос слишком большой');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:3000');

  if (url.pathname === '/api/checklist') {
    if (request.method === 'GET') {
      return sendJson(response, 200, getActiveChecklist());
    }

    if (request.method === 'PUT') {
      try {
        const rules = await readRequestJson(request);
        return sendJson(response, 200, saveActiveChecklist(rules));
      } catch (error) {
        return sendJson(response, error.code ? 500 : 400, { error: error.message });
      }
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/appeals') {
    const id = url.searchParams.get('id');
    if (!conversations.has(id)) {
      return sendJson(response, 404, { error: 'Диалог не найден' });
    }

    let body;
    try {
      body = await readRequestJson(request);
    } catch {
      return sendJson(response, 400, { error: 'Не удалось прочитать апелляцию' });
    }

    const criterionId = body?.criterion_id;
    const comment = typeof body?.comment === 'string' ? body.comment.trim() : '';
    if (!comment || comment.length > 1000) {
      return sendJson(response, 400, {
        error: 'Напиши комментарий длиной от 1 до 1000 знаков',
      });
    }

    const review = getReview(id);
    if (running.has(id) || hasPendingAppeal(review)) {
      return sendJson(response, 409, {
        error: 'Дождись завершения оценки или рассмотрения апелляции',
      });
    }

    const original = review.evaluation;
    if (original?.status !== 'ok' ||
        !original.criteria.some((item) => item.criterion_id === criterionId)) {
      return sendJson(response, 400, {
        error: 'Выбери критерий из сохранённой оценки',
      });
    }

    const appeal = {
      id: randomUUID(),
      criterion_id: criterionId,
      comment,
      status: 'pending',
      original,
      checklist: review.checklist,
    };

    try {
      saveUiEvaluation(id, {
        ...review,
        appeals: [...(review.appeals ?? []), appeal],
      });
      return sendJson(response, 201, { appeal });
    } catch {
      return sendJson(response, 500, { error: 'Не удалось сохранить апелляцию' });
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/appeals/resolve') {
    const id = url.searchParams.get('id');
    if (!conversations.has(id)) {
      return sendJson(response, 404, { error: 'Диалог не найден' });
    }

    let body;
    try {
      body = await readRequestJson(request);
    } catch {
      return sendJson(response, 400, { error: 'Не удалось прочитать решение' });
    }

    const action = body?.action;
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if ((action !== 'confirm' && action !== 'change') || !reason || reason.length > 1000) {
      return sendJson(response, 400, { error: 'Выбери решение и укажи причину до 1000 знаков' });
    }

    const review = getReview(id);
    const appeals = review.appeals ?? [];
    const appeal = appeals.find((item) => item.id === body?.appeal_id);
    if (!appeal) {
      return sendJson(response, 404, { error: 'Апелляция не найдена' });
    }
    if (appeal.status !== 'pending') {
      return sendJson(response, 409, {
        error: 'Решение по этой апелляции уже сохранено. Обнови страницу.',
      });
    }

    const original = appeal.original;
    const criterion = original.criteria.find((item) => item.criterion_id === appeal.criterion_id);
    const value = action === 'confirm' ? criterion.value : body.value;

    if (action === 'change' && value === criterion.value) {
      return sendJson(response, 400, { error: 'Выбери другое значение или подтверди исходную оценку' });
    }

    const criteria = action === 'confirm' ? original.criteria : original.criteria.map((item) => (
      item.criterion_id === appeal.criterion_id ? { ...item, value, rationale: reason } : item
    ));
    const answers = Object.fromEntries(criteria.map((item) => [item.criterion_id, item.value]));

    let score;
    try {
      score = calculateScore(appeal.checklist, answers);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }

    const evaluation = { ...original, criteria, score };
    const resolved = {
      ...appeal,
      status: 'resolved',
      decision: { action, value, reason },
      final: evaluation,
    };

    try {
      saveUiEvaluation(id, {
        ...review,
        evaluation,
        checklist: appeal.checklist,
        appeals: appeals.map((item) => item.id === resolved.id ? resolved : item),
      });
      return sendJson(response, 200, { appeal: resolved, evaluation });
    } catch {
      return sendJson(response, 500, { error: 'Не удалось сохранить решение' });
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/evaluate') {
    const id = url.searchParams.get('id');
    const conversation = conversations.get(id);

    if (!conversation) return sendJson(response, 404, { error: 'Диалог не найден' });
    if (running.has(id)) {
      return sendJson(response, 409, { error: 'Этот диалог уже оценивается' });
    }

    const review = getReview(id);
    if (hasPendingAppeal(review)) {
      return sendJson(response, 409, {
        error: 'Сначала нужно рассмотреть открытую апелляцию',
      });
    }

    const activeChecklist = getActiveChecklist();
    running.add(id);

    try {
      const evaluation = await evaluateConversation(conversation, activeChecklist);
      saveUiEvaluation(id, { ...review, evaluation, checklist: activeChecklist });
      return sendJson(response, 200, { evaluation });
    } catch (error) {
      return sendJson(response, 500, { error: error.cause?.code ?? error.message });
    } finally {
      running.delete(id);
    }
  }

  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return response.end(page);
  }

  if (request.method === 'GET' && url.pathname === '/api/conversations') {
    const id = url.searchParams.get('id');
    if (id === null) return sendJson(response, 200, list);

    const conversation = conversations.get(id);
    if (!conversation) return sendJson(response, 404, { error: 'Диалог не найден' });

    const review = getReview(id);
    return sendJson(response, 200, {
      conversation,
      evaluation: review.evaluation,
      checklist: review.checklist,
      appeals: review.appeals ?? [],
      sections: getSectionScores(review),
    });
  }

  sendJson(response, 404, { error: 'Страница не найдена' });
}).listen(3000, '127.0.0.1', () => {
  console.log('Открой http://127.0.0.1:3000');
});