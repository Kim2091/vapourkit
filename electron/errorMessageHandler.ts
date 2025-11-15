// electron/errorMessageHandler.ts
import { logger } from './logger';

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
