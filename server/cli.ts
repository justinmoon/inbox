import path from 'node:path';

import { readConfig } from './config.ts';
import { clearImportedBundles, discoverBundleFiles, persistImportedBundle } from './importBundles.ts';

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const config = readConfig(process.env);

  if (command === 'import') {
    const bundleFlag = rest.findIndex((arg) => arg === '--bundle');
    const bundleArg = bundleFlag >= 0 ? rest[bundleFlag + 1] : null;
    if (!bundleArg) {
      throw new Error('Usage: npm run import -- --bundle path/to/change-unit.json');
    }

    const bundlePath = path.resolve(process.cwd(), bundleArg);
    const { bundle, targetPath } = await persistImportedBundle(bundlePath, config.importedRoot);
    console.log(`Imported ${bundle.change_unit.id} into ${targetPath}`);
    return;
  }

  if (command === 'reseed') {
    const bundlePaths = await discoverBundleFiles(config.seedRoot);
    if (bundlePaths.length === 0) {
      throw new Error(`No seed bundles found under ${config.seedRoot}`);
    }

    await clearImportedBundles(config.importedRoot);
    console.log(`Reset to ${bundlePaths.length} seed bundles from ${config.seedRoot}`);
    return;
  }

  throw new Error('Usage: npm run import -- --bundle path/to/change-unit.json | npm run reseed');
}

await main();
