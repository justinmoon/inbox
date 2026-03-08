import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { changeUnitBundleSchema } from '../shared/changeUnitBundle.ts';

const outputPath = path.resolve(process.cwd(), 'schema/change-unit.bundle.schema.json');
const schema = z.toJSONSchema(changeUnitBundleSchema);

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');

console.log(outputPath);
