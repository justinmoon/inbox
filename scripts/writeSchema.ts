import fs from 'node:fs/promises';
import path from 'node:path';

import { zodToJsonSchema } from 'zod-to-json-schema';

import { changeUnitBundleSchema } from '../shared/changeUnitBundle.ts';

const outputPath = path.resolve(process.cwd(), 'schema/change-unit.bundle.schema.json');

const schema = zodToJsonSchema(changeUnitBundleSchema as any, {
  name: 'ChangeUnitBundle',
  $refStrategy: 'none',
});

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');

console.log(outputPath);
