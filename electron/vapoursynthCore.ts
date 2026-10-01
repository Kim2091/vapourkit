// electron/vapoursynthCore.ts
//
// The pinned VapourSynth core, and what to tell the user when the core on disk
// is past it. Imports nothing, so the error formatters can use it without
// pulling in Electron (constants.ts reads app paths at module scope).

// The core VapourSynth runtime, pinned rather than tracked. R79 is the core
// every plugin wheel and bundled filter in this repo has been verified against,
// and the last one that still loads API 3 plugins, which vs-mlrt's ort/trt
// are. R80 dropped them. Letting pip pick up the next release on a user's
// machine would change the runtime under a plugin set nobody has tested there
// yet. Bump this deliberately, after re-checking the filters.
export const VAPOURSYNTH_VERSION = '79';

/**
 * What VapourSynth prints for every API 3 plugin from R80 on. R79 still loads
 * them, and vs-mlrt's ort/trt are API 3, so seeing this means the core on disk
 * is past the pin.
 */
export const API3_UNSUPPORTED = /uses API 3, which is no longer supported/i;

/**
 * Replaces "No attribute with the name ort exists", which names the wrong
 * cause, in script errors from a core past the pin. The launch check puts the
 * pin back, so a restart is the fix; when it is not, the log says why.
 */
export function describeCoreTooNew(): string {
  return `A VapourSynth newer than R${VAPOURSYNTH_VERSION} is installed, and it no longer loads plugins Vapourkit ` +
    `needs (including ONNX Runtime and TensorRT). Restart Vapourkit to reinstall R${VAPOURSYNTH_VERSION}. ` +
    'If this keeps appearing, check your internet connection and allow Vapourkit\'s folder in your antivirus.';
}
