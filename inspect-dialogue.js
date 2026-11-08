const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const filePath = join(__dirname, 'data', 'dev.json');
const dataset = JSON.parse(readFileSync(filePath, 'utf8'));
const records = dataset.data.records;
const chat = records.find((record) => record.channel === 'agent chat');

console.log(`Всего диалогов: ${records.length}`);
console.log(`Чат: ${chat.conversation_id} | Язык: ${chat.language}`);

chat.transcript.forEach((turn, index) => {
  console.log(`${index + 1}. [${turn.timestamp}] ${turn.speaker}: ${turn.text}`);
});