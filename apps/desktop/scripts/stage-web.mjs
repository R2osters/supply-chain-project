// Builds the static export of apps/web and assembles the desktop frontend:
//   web-dist/            -> embedded in SCIP.exe as the webview's frontend
//   web-dist/splash/     -> startup screen, the window's first page
//   resources/web/       -> same export on disk, served by the API to phones on the LAN
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DESKTOP_DIR, REPO_DIR, RESOURCES_DIR, isMain, run } from './lib/fetch.mjs';

export async function stageWeb() {
  const webDir = join(REPO_DIR, 'apps', 'web');
  const exportDir = join(webDir, 'out');

  // A NEXT_PUBLIC_API_URL left in the build shell would be inlined and pin the app to a fixed
  // address; the desktop resolves it at runtime instead.
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
  delete env.NEXT_PUBLIC_API_URL;
  delete env.NEXT_PUBLIC_WS_URL;

  run('npm', ['run', 'build', '--workspace', '@scip/shared'], { cwd: REPO_DIR });
  rmSync(exportDir, { recursive: true, force: true });
  run('npm', ['run', 'build', '--workspace', '@scip/web'], { cwd: REPO_DIR, env });

  const webDist = join(DESKTOP_DIR, 'web-dist');
  rmSync(webDist, { recursive: true, force: true });
  cpSync(exportDir, webDist, { recursive: true });
  cpSync(join(DESKTOP_DIR, 'splash'), join(webDist, 'splash'), { recursive: true });

  const lanCopy = join(RESOURCES_DIR, 'web');
  rmSync(lanCopy, { recursive: true, force: true });
  cpSync(exportDir, lanCopy, { recursive: true });
  console.log(`  web -> ${webDist} and ${lanCopy}`);
}

if (isMain(import.meta.url)) {
  await stageWeb();
}
