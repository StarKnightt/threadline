import "./scripts/lib/env";
import { query, close, BRAIN } from "./src/lib/falkor";
(async () => {
  const q = process.argv[2];
  const r = await query(BRAIN, q, {}, { ro: true });
  console.log(JSON.stringify(r.rows, null, 0).slice(0, 3000));
  await close();
})();
