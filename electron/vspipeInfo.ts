// electron/vspipeInfo.ts

export interface OutputInfo {
  /** Output frame count; 0 when it could not be read. */
  frames: number;
  resolution: string | null;
  fps: number | null;
  fpsString: string | null;
  pixelFormat?: string | null;
  /**
   * True when the output clip has no constant rate and vspipe writes each
   * frame's own timestamp. fps and fpsString then hold the average rate the
   * script reported, or null.
   */
  variableFrameRate?: boolean;
  error?: string | null;
}

/**
 * Reads the output clip's frame count, resolution, frame rate and format from
 * what `vspipe -i` printed (stdout and stderr together). A clip with no
 * constant rate prints `FPS: Variable`; vk_timed_output() then also prints a
 * `[vk-timing] vfr average_rate=n/d` line on stderr with the average.
 */
export function parseVspipeInfo(output: string): OutputInfo {
  const widthMatch = output.match(/Width:\s*(\d+)/i);
  const heightMatch = output.match(/Height:\s*(\d+)/i);
  const fpsMatch = output.match(/FPS:\s*(\d+)\/(\d+)\s*\(([\d.]+)\s*fps\)/i);
  const variableFrameRate = !fpsMatch && /FPS:\s*Variable/i.test(output);
  const averageMatch = output.match(/\[vk-timing\] vfr average_rate=(\d+)\/(\d+)/);
  const formatMatch = output.match(/Format Name:\s*(\w+)/i);
  const framesMatch = output.match(/Frames:\s*(\d+)/i);

  let fps: number | null = null;
  let fpsString: string | null = null;
  if (fpsMatch) {
    // Use the decimal value (third capture group)
    fps = parseFloat(fpsMatch[3]);
    fpsString = `${fpsMatch[1]}/${fpsMatch[2]}`;
  } else if (variableFrameRate && averageMatch && parseInt(averageMatch[2], 10) > 0) {
    fps = Math.round(parseInt(averageMatch[1], 10) / parseInt(averageMatch[2], 10) * 1000) / 1000;
    fpsString = `${averageMatch[1]}/${averageMatch[2]}`;
  }

  return {
    frames: framesMatch ? parseInt(framesMatch[1], 10) : 0,
    resolution: widthMatch && heightMatch ? `${parseInt(widthMatch[1], 10)}x${parseInt(heightMatch[1], 10)}` : null,
    fps,
    fpsString,
    pixelFormat: formatMatch ? formatMatch[1] : null,
    variableFrameRate,
  };
}
