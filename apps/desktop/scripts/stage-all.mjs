// Fills everything the installer ships. Run before `npm run build`:
//   node scripts/stage-all.mjs            all components
//   node scripts/stage-all.mjs web api    only some (node, postgres, api, ai, web, defaults)
import { isMain } from './lib/fetch.mjs';
import { stageAi } from './stage-ai.mjs';
import { stageApi } from './stage-api.mjs';
import { stageDefaults } from './stage-defaults.mjs';
import { stageNode } from './stage-node.mjs';
import { stagePostgres } from './stage-postgres.mjs';
import { stageWeb } from './stage-web.mjs';

const STAGES = {
  node: stageNode,
  postgres: stagePostgres,
  api: stageApi,
  ai: stageAi,
  web: stageWeb,
  defaults: stageDefaults,
};

export async function stageAll(names = Object.keys(STAGES)) {
  for (const name of names) {
    const stage = STAGES[name];
    if (!stage) throw new Error(`Unknown component "${name}". Known: ${Object.keys(STAGES).join(', ')}`);
    console.log(`[stage] ${name}`);
    await stage();
  }
}

if (isMain(import.meta.url)) {
  const requested = process.argv.slice(2);
  await stageAll(requested.length > 0 ? requested : undefined);
}
