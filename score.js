const defaultChecklist = require('./checklist.json');

function calculateScore(checklist, answers) {
  let earnedPoints = 0;
  let applicableWeight = 0;

  for (const { id, weight, scale, allowNA } of checklist) {
    const value = answers[id];

    if (value === null && allowNA) {
      continue;
    }

    const isValid = scale ? scale.includes(value) : typeof value === 'boolean';
    if (!isValid) {
      throw new Error(`Недопустимая оценка для ${id}: ${value}`);
    }

    const fraction = scale ? value / Math.max(...scale) : Number(value);
    earnedPoints += weight * fraction;
    applicableWeight += weight;
  }

  const finalScore = applicableWeight > 0
    ? Number((100 * earnedPoints / applicableWeight).toFixed(2))
    : null;

  return {
    final_score: finalScore,
    critical_flag: answers.critical === true,
  };
}

module.exports = { defaultChecklist, calculateScore };