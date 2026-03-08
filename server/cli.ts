import path from 'node:path';

import { readConfig } from './config.ts';
import { discoverBundleFiles, loadBundleFromPath } from './importBundles.ts';
import { InboxDatabase } from './storage.ts';

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const config = readConfig(process.env);
  const db = new InboxDatabase(config.dbPath);

  if (command === 'import') {
    const bundleFlag = rest.findIndex((arg) => arg === '--bundle');
    const bundleArg = bundleFlag >= 0 ? rest[bundleFlag + 1] : null;
    if (!bundleArg) {
      throw new Error('Usage: npm run import -- --bundle path/to/change-unit.json');
    }
    const bundlePath = path.resolve(process.cwd(), bundleArg);
    const bundle = await loadBundleFromPath(bundlePath);
    db.importBundle(bundle);
    console.log(`Imported ${bundle.change_unit.id} from ${bundlePath}`);
    return;
  }

  if (command === 'reseed') {
    const bundlePaths = await discoverBundleFiles(config.seedRoot);
    if (bundlePaths.length === 0) {
      throw new Error(`No seed bundles found under ${config.seedRoot}`);
    }
    db.clearAll();
    for (const bundlePath of bundlePaths) {
      db.importBundle(await loadBundleFromPath(bundlePath));
    }
    console.log(`Imported ${bundlePaths.length} seed bundles into ${config.dbPath}`);
    return;
  }

  throw new Error('Usage: npm run import -- --bundle path/to/change-unit.json | npm run reseed');
}

await main();
