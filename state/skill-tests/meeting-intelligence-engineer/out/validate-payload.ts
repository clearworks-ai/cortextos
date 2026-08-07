import { validateDreamPayload } from '../../../../src/bus/kb-graph/dream';
import * as fs from 'fs';
const raw = JSON.parse(fs.readFileSync(__dirname + '/kb-meeting-payload.json','utf8'));
const r = validateDreamPayload(raw) as any;
console.log(JSON.stringify({ok:r.ok, errors:r.errors||null, entities:r.ok?r.payload.entities.length:0, edges:r.ok?r.payload.edges.length:0, pages:r.ok?r.payload.pages.length:0}));
