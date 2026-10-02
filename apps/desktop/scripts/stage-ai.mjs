// Builds the AI service with PyInstaller (services/ai/build-desktop.ps1 on Windows,
// build-desktop.sh on macOS and Linux) and copies the onedir output to resources/ai, where the
// supervisor expects resources/ai/scip-ai.exe (scip-ai elsewhere).
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EXE, IS_WINDOWS, REPO_DIR, RESOURCES_DIR, isMain, run } from './lib/fetch.mjs';
import { flattenLinks, signUnsignedBinaries } from './lib/unix.mjs';

export async function stageAi() {
  const aiDir = join(REPO_DIR, 'services', 'ai');
  if (IS_WINDOWS) {
    run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'build-desktop.ps1'], {
      cwd: aiDir,
    });
  } else {
    run('bash', ['build-desktop.sh'], { cwd: aiDir });
  }

  const built = join(aiDir, 'dist', 'scip-ai');
  if (!existsSync(join(built, `scip-ai${EXE}`))) {
    throw new Error(`PyInstaller output not found in ${built}`);
  }
  const target = join(RESOURCES_DIR, 'ai');
  // Retries: antivirus scanners briefly lock freshly written .exe/.node files on Windows.
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  cpSync(built, target, { recursive: true, verbatimSymlinks: !IS_WINDOWS });
  if (!IS_WINDOWS) {
    // PyInstaller links a library it would otherwise ship twice; the bundle cannot carry links.
    flattenLinks(target);
    signUnsignedBinaries(target);
  }
  console.log(`  ai -> ${target}`);
}

if (isMain(import.meta.url)) {
  await stageAi();
}
