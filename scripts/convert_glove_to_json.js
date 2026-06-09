// scripts/convert_glove_to_json.js
import fs from 'fs';

const DIM = 100;
const INPUT = 'C:\\Users\\ASUS\\Downloads\\glove.6B\\glove.6B.100d.txt';
const OUTPUT = 'data/glove.6B.100d.tech.json';

// Optional: filter to technical terms (or just take top 50k)
const lines = fs.readFileSync(INPUT, 'utf8').split('\n');
const vectors = {};

let count = 0;
for (const line of lines) {
  if (!line.trim()) continue;
  const parts = line.split(' ');
  const word = parts[0].toLowerCase();
  const vec = parts.slice(1, 1 + DIM).map(Number);
  if (vec.length === DIM) {
    vectors[word] = vec;
    count++;
    if (count >= 100000) break; // limit for speed
  }
}

fs.writeFileSync(OUTPUT, JSON.stringify({ dim: DIM, vectors }, null, 0));
console.log(`Wrote ${count} vectors to ${OUTPUT}`);