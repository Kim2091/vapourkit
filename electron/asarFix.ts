// electron/asarFix.ts
// Fix 7zip-bin path for ASAR. Must be imported BEFORE any module imports 7zip-min,
// since 7zip-min reads the path at require time. Import this first in main.ts.
import { fixAsarPath } from './utils';

const sevenBin = require('7zip-bin');
sevenBin.path7za = fixAsarPath(sevenBin.path7za);
