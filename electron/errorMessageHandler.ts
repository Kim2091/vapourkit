// electron/errorMessageHandler.ts
import { logger } from './logger';
import { API3_UNSUPPORTED, describeCoreTooNew } from './vapoursynthCore';
import { stripPluginLoadWarnings } from './vapourSynthErrorFormatter';
import { describeNvencDriverError, parseNvencDriverError } from './nvencCheck';

/**
 * Utility class for handling and formatting error messages from subprocess output
 */
export class ErrorMessageHandler {
  /**
   * Extracts the most relevant error message from stderr output
   * Clips long messages while preserving important error details
   */
  static extractErrorMessage(stderr: string, maxLength: number = 300): string {
    if (!stderr || stderr.trim().length === 0) {
      return 'Unknown error (no error details available)';
    }

    // Log the full error content before any clipping
    logger.error('Full stderr output:', stderr);

    // vsmigx loads the HIP runtime lazily, on the first MIGraphX call. When
    // the GPU or driver can't run it, the load failure kills vspipe outright
    // (no Python exception), leaving only this line to go on.
    if (/vsmigx: failed to preload .*amdhip64/i.test(stderr)) {
      return 'MIGraphX could not start the AMD HIP runtime. This GPU or driver is not supported by MIGraphX ' +
        '(it needs an RX 6800 / RDNA3 or newer GPU and a current AMD driver). Switch the inference backend to DirectML or NCNN.';
    }

    // A core past the pin fails with "No attribute with the name ort exists",
    // which names the wrong cause; see vapoursynthPin.ts.
    if (API3_UNSUPPORTED.test(stderr)) {
      return describeCoreTooNew();
    }

    // ffmpeg's NVENC refusing an old driver ends in "Output file is empty",
    // which names no cause at all; see nvencCheck.ts.
    const nvenc = parseNvencDriverError(stderr);
    if (nvenc) {
      return describeNvencDriverError(nvenc);
    }

    // The API3 autoload notices are never the error, and with nothing else
    // printed they were all the "last lines" fallback below had to show.
    stderr = stripPluginLoadWarnings(stderr);
    if (!stderr) {
      return 'VapourSynth stopped without printing an error. The log has its full output.';
    }

    // Common error patterns to look for (in order of priority)
    const errorPatterns = [
      /Error:\s*(.+?)(?:\n|$)/i,
      /Failed to retrieve frame \d+ with error:\s*(.+?)(?:\n|$)/i,
      /Exception:\s*(.+?)(?:\n|$)/i,
      /error \d+:\s*(.+?)(?:\n|$)/i,
      /\[error\]\s*(.+?)(?:\n|$)/i,
      /traceback.*?:\s*(.+?)(?:\n|$)/is
    ];

    // Try to find a specific error message
    for (const pattern of errorPatterns) {
      const match = stderr.match(pattern);
      if (match && match[1]) {
        let errorMsg = match[1].trim();
        
        // If the error message is too long, clip it intelligently
        if (errorMsg.length > maxLength) {
          errorMsg = errorMsg.substring(0, maxLength) + '...';
        }
        
        return errorMsg;
      }
    }

    // If no specific pattern matched, take the last few non-empty lines
    const lines = stderr.split('\n').filter(line => line.trim().length > 0);
    if (lines.length > 0) {
      // Take up to the last 3 lines
      const relevantLines = lines.slice(-3).join(' | ');
      
      if (relevantLines.length > maxLength) {
        return relevantLines.substring(0, maxLength) + '...';
      }
      
      return relevantLines;
    }

    return 'Unknown error (see logs for details)';
  }

  /**
   * Formats an error message for user display with guidance to send logs
   */
  static formatUserErrorMessage(errorType: string, errorDetail: string): string {
    return `${errorType}: ${errorDetail}\n\nIf this issue persists, please send the log file to the developer.\nLog location: ${logger.getLogPath()}`;
  }
}
