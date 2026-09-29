// Builds the AI service with PyInstaller (services/ai/build-desktop.ps1) and copies the onedir
// output to resources/ai, where the supervisor expects resources/ai/scip-ai.exe.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_DIR, RESOURCES_DIR, isMain, run } from './lib/fetch.mjs';

export async function stageAi() {
  const aiDir = join(REPO_DIR, 'services', 'ai');
  run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'build-desktop.ps1'], {
    cwd: aiDir,
  });

  const built = join(aiDir, 'dist', 'scip-ai');
  if (!existsSync(join(built, 'scip-ai.exe'))) {
    throw new Error(`PyInstaller output not found in ${built}`);
  }
  const target = join(RESOURCES_DIR, 'ai');
  // Retries: antivirus scanners briefly lock freshly written .exe/.node files on Windows.
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  cpSync(built, target, { recursive: true });
  console.log(`  ai -> ${target}`);
}

if (isMain(import.meta.url)) {
  await stageAi();
}
