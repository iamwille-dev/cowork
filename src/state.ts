import { resolve } from 'node:path';

export const coworkStateDir = resolve(process.env.COWORK_STATE_DIR || 'backend/.cowork');
