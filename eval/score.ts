// Scoring for the graph vs vector evaluation. Answers end with "ANSWER: a; b; c".
export function answerItems(answer: string): string[] {
  const line = [...answer.matchAll(/ANSWER\s*:\s*(.+)/gi)].pop()?.[1] ?? "";
  return line
    .split(/[;,]|\band\b/)
    .map(normalise)
    .filter(Boolean);
}

export function normalise(s: string): string {
  let x = s.trim().toLowerCase().replace(/[*`"'[\]()【】]/g, "").trim();
  const key = /^(?:pr|issue):[^#]+#(\d+)$/.exec(x);
  if (key) return `#${key[1]}`;
  x = x.replace(/^person:/, "").replace(/^@/, "");
  const rel = /^release:[^@]+@(.+)$/.exec(x);
  if (rel) x = rel[1];
  const num = /(?:^|\s|\/)(?:pr|issue|pull request)?\s*#?(\d{1,5})$/.exec(x);
  if (num && /#|pr|issue|pull/.test(x)) return `#${num[1]}`;
  if (/^#\d+$/.test(x)) return x;
  if (/^v?\d+\.\d+(\.\d+)?([-.][\w.]+)?$/.test(x)) return x.replace(/^v/, "");
  return x.split(/\s+/)[0];
}

const goldNorm = (g: string) => (/^v?\d+\.\d+/.test(g) ? g.replace(/^v/, "") : g);

export function score(answer: string, gold: string[]) {
  const pred = [...new Set(answerItems(answer))];
  const g = new Set(gold.map((x) => goldNorm(x.toLowerCase())));
  const hit = pred.filter((p) => g.has(p)).length;
  const precision = pred.length ? hit / pred.length : 0;
  const recall = g.size ? [...g].filter((x) => pred.includes(x)).length / g.size : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { pred, precision, recall, f1, exact: recall === 1 && precision === 1 };
}
