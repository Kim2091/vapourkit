// VapourSynth emits one of these non-fatal notices for every legacy API3
// plugin it autoloads. They are kept in the full vspipe log, but must not
// obscure a script traceback in a user-facing validation error.
const API3_PLUGIN_DEPRECATION_WARNING =
  /^Warning:\s+Plugin\s+.+?\s+is using API3 which is deprecated and will be removed shortly\.\s*$/i;

/**
 * Removes known non-fatal VapourSynth plugin startup warnings from an error
 * presented to the user. All other warnings, output, and tracebacks remain.
 */
export function formatVapourSynthValidationError(output: string): string {
  const filtered = output
    .split(/\r?\n/)
    .filter(line => !API3_PLUGIN_DEPRECATION_WARNING.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return filtered || 'VapourSynth failed before producing output. Check the log for details.';
}
