const { existsSync, readFileSync, writeFileSync, renameSync } = require('node:fs');
const { join } = require('node:path');
const { defaultChecklist } = require('./score');

const file = join(__dirname, 'data', 'checklist-active.json');
let active = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8'))
  : defaultChecklist;

function validate(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('Добавь хотя бы один критерий');
  }

  const ids = new Set();
  for (const rule of rules) {
    if (typeof rule?.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(rule.id) || ids.has(rule.id)) {
      throw new Error('У критериев должны быть уникальные ID');
    }
    ids.add(rule.id);

    if (typeof rule.label !== 'string' || !rule.label.trim() ||
        typeof rule.rule !== 'string' || !rule.rule.trim()) {
      throw new Error('Заполни название и правило каждого критерия');
    }
    if (!Number.isFinite(rule.weight) || rule.weight < 0 || typeof rule.allowNA !== 'boolean') {
      throw new Error(`Проверь вес и N/A у критерия «${rule.label}»`);
    }
    if (rule.scale !== undefined && (
      !Array.isArray(rule.scale) ||
      !rule.scale.every((value) => Number.isFinite(value) && value >= 0) ||
      !rule.scale.some((value) => value > 0) ||
      new Set(rule.scale).size !== rule.scale.length
    )) {
      throw new Error(`Шкала «${rule.label}» должна содержать разные неотрицательные числа, хотя бы одно выше нуля`);
    }
    if (rule.id === 'critical' && (rule.weight !== 0 || rule.scale !== undefined || rule.allowNA)) {
      throw new Error('Грубые ошибки оцениваются ответом «Да» или «Нет» с весом 0');
    }
  }

  if (!ids.has('critical') || !rules.some((rule) => rule.weight > 0)) {
    throw new Error('Нужны критерий грубых ошибок и хотя бы один критерий с положительным весом');
  }
}

function getActiveChecklist() {
  return active;
}

function saveActiveChecklist(rules) {
  validate(rules);
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(rules, null, 2) + '\n', 'utf8');
  renameSync(temp, file);
  active = rules;
  return active;
}

module.exports = { getActiveChecklist, saveActiveChecklist };