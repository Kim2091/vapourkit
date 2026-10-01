import { API3_UNSUPPORTED, describeCoreTooNew } from './vapoursynthCore';

// VapourSynth emits one of these non-fatal notices for every legacy API3
// plugin it autoloads. They are kept in the full vspipe log, but must not
// obscure a script traceback in a user-facing validation error.
const API3_PLUGIN_DEPRECATION_WARNING =
  /^Warning:\s+Plugin\s+.+?\s+is using API3 which is deprecated and will be removed shortly\.\s*$/i;

// R80 and later refuse API3 plugins outright, one line per plugin. The lines
// are replaced by a single explanation, since the traceback they lead to
// ("No attribute with the name ort exists") names the wrong cause.
const API3_PLUGIN_UNSUPPORTED_LINE =
  /^(Warning|Critical):\s+Plugin\s+.+?\s+uses API 3, which is no longer supported\.\s*$/i;

/**
 * Removes the per-plugin API3 notices VapourSynth prints at autoload, leaving
 * every other line. Every path that turns vspipe output into a message uses
 * it: on an install with a dozen API3 plugins they are all a failed run
 * prints, and they pushed the real error out of view.
 */
export function stripPluginLoadWarnings(output: string): string {
  return output
    .split(/\r?\n/)
    .filter(line => !API3_PLUGIN_DEPRECATION_WARNING.test(line) && !API3_PLUGIN_UNSUPPORTED_LINE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Removes known non-fatal VapourSynth plugin startup warnings from an error
 * presented to the user. All other warnings, output, and tracebacks remain.
 * A core past the pin gets its explanation first.
 */
export function formatVapourSynthValidationError(output: string): string {
  const filtered = stripPluginLoadWarnings(output);

  if (API3_UNSUPPORTED.test(output)) {
    return filtered ? `${describeCoreTooNew()}\n\n${filtered}` : describeCoreTooNew();
  }
  return filtered || 'VapourSynth failed before producing output. Check the log for details.';
}
