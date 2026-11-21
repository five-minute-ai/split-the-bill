// Checks bill.json before going live: required fields, readable prices,
// and above all that the items add up to the receipt total.
// Run: npm run check
import { readFileSync } from "node:fs";

const b = JSON.parse(readFileSync(new URL("./bill.json", import.meta.url), "utf8"));
const errors = [];
const c = (x) => Math.round(Number(x) * 100);

if (!b.title) errors.push('"title" is missing');
if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ""))) errors.push('"date" must be written YYYY-MM-DD, e.g. 2026-11-21');
if (!(Number.isInteger(b.people) && b.people > 0)) errors.push('"people" must be a whole number, e.g. 6');
if (!/^[A-Z]{3}$/.test(String(b.currency || ""))) errors.push('"currency" must be a 3-letter code, e.g. USD');
if (!b.payer) errors.push('"payer" is missing: the first name of whoever paid');
if (!Array.isArray(b.items) || !b.items.length) errors.push('"items" is empty');

let sum = 0;
(b.items || []).forEach((it, i) => {
  const n = `item ${i + 1} (${it.name || "no name"})`;
  if (!it.name) errors.push(`${n}: "name" is missing`);
  if (!(Number.isInteger(it.quantity) && it.quantity > 0)) errors.push(`${n}: "quantity" must be a whole number`);
  if (!(Number(it.price) > 0)) errors.push(`${n}: "price" must be the price of ONE unit, e.g. 4.5`);
  sum += c(it.price) * (it.quantity || 0);
});

for (const p of b.payments || []) {
  if (p.link && !/^https?:\/\//.test(p.link)) errors.push(`payment "${p.name}": the link must start with https://`);
  if (p.link && /example\.com/.test(p.link)) errors.push(`payment "${p.name}": replace the example link with yours`);
  if (p.text && /000 000/.test(p.text)) errors.push(`payment "${p.name}": replace the example text with yours`);
}

if (b.receipt_total !== undefined && c(b.receipt_total) !== sum) {
  errors.push(`the items add up to ${(sum / 100).toFixed(2)}, not the receipt total (${Number(b.receipt_total).toFixed(2)}): check quantities and prices`);
}

if (errors.length) {
  console.error("bill.json needs fixing:\n- " + errors.join("\n- "));
  process.exit(1);
}
console.log(`bill.json looks good: ${b.items.length} items, total ${(sum / 100).toFixed(2)} ${b.currency}, ${b.people} people.`);
