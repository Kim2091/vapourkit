// src/utils/gradeRenderer.ts — the grade, applied to a cached frame on the GPU.
//
// Re-rendering the chain through vspipe for every knob move takes seconds once
// a model is upstream, which is not a grading loop. So the frame that enters
// the grade step is rendered once and cached, and dragging a trackball only
// re-shades that texture. The shader is generated from the same model as the
// emitted Python (src/utils/colorGrade.ts), so what you see is what renders.

import {
  GRADE_FRAGMENT_SHADER,
  GRADE_VERTEX_SHADER,
  GRADE_NEUTRAL,
  shaderUniforms,
  type GradeValues,
} from './colorGrade';

type Uniforms = ReturnType<typeof shaderUniforms>;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Could not create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Grade shader failed to compile: ${log}`);
  }
  return shader;
}

/**
 * Owns one canvas and one texture. Create it when the grading dock opens,
 * dispose it when the dock closes — a leaked WebGL context is not collected
 * on a timescale that matters, and browsers cap how many exist at once.
 */
export class GradeRenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private texture: WebGLTexture;
  private buffer: WebGLBuffer;
  private locations: Record<string, WebGLUniformLocation | null> = {};
  private size = { width: 0, height: 0 };
  private disposed = false;

  constructor(private canvas: HTMLCanvasElement) {
    // preserveDrawingBuffer matters here: this renderer draws on demand, when
    // the grade changes, not once per animation frame. Without it the buffer's
    // contents are undefined after the compositor takes them, so any repaint
    // that does not coincide with a redraw can show an empty canvas.
    const gl = canvas.getContext('webgl', { alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL is not available');
    // A canvas hands back the same context object every time, so one that was
    // lost earlier comes back lost — every create* call would silently return
    // null and the failure would surface as a confusing link error.
    if (gl.isContextLost()) throw new Error('The WebGL context for this canvas was lost');
    this.gl = gl;

    const program = gl.createProgram();
    if (!program) throw new Error('Could not create shader program');
    const vertex = compile(gl, gl.VERTEX_SHADER, GRADE_VERTEX_SHADER);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, GRADE_FRAGMENT_SHADER);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Grade shader failed to link: ${gl.getProgramInfoLog(program)}`);
    }
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    this.program = program;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('Could not create vertex buffer');
    this.buffer = buffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    if (!texture) throw new Error('Could not create frame texture');
    this.texture = texture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // The frame is not a power of two, so clamp and stay on linear filtering.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    for (const name of [
      'uFrame', 'uOffset', 'uGain', 'uLift', 'uInvGamma',
      'uContrast', 'uPivot', 'uBrightness', 'uSaturation', 'uHueCos', 'uHueSin',
    ]) {
      this.locations[name] = gl.getUniformLocation(program, name);
    }
    gl.uniform1i(this.locations.uFrame, 0);
  }

  get isLost(): boolean {
    return this.disposed || this.gl.isContextLost();
  }

  /** Uploads the frame the grade step receives. Call once per cached frame. */
  setFrame(image: TexImageSource, width: number, height: number): void {
    if (this.isLost) return;
    const gl = this.gl;
    this.size = { width, height };
    this.canvas.width = width;
    this.canvas.height = height;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.viewport(0, 0, width, height);
  }

  get frameSize(): { width: number; height: number } {
    return this.size;
  }

  /** Draws the frame with the grade applied. Pass neutral values for "before". */
  render(values: GradeValues): void {
    if (this.isLost || this.size.width === 0) return;
    const gl = this.gl;
    const u: Uniforms = shaderUniforms(values);
    gl.useProgram(this.program);
    gl.uniform3f(this.locations.uOffset, u.uOffset[0], u.uOffset[1], u.uOffset[2]);
    gl.uniform3f(this.locations.uGain, u.uGain[0], u.uGain[1], u.uGain[2]);
    gl.uniform3f(this.locations.uLift, u.uLift[0], u.uLift[1], u.uLift[2]);
    gl.uniform3f(this.locations.uInvGamma, u.uInvGamma[0], u.uInvGamma[1], u.uInvGamma[2]);
    gl.uniform1f(this.locations.uContrast, u.uContrast);
    gl.uniform1f(this.locations.uPivot, u.uPivot);
    gl.uniform1f(this.locations.uBrightness, u.uBrightness);
    gl.uniform1f(this.locations.uSaturation, u.uSaturation);
    gl.uniform1f(this.locations.uHueCos, u.uHueCos);
    gl.uniform1f(this.locations.uHueSin, u.uHueSin);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  renderNeutral(): void {
    this.render(GRADE_NEUTRAL);
  }

  /**
   * Releases the GPU objects but deliberately does NOT call
   * WEBGL_lose_context.loseContext(). A canvas returns the same context object
   * forever, so losing it poisons the element: any later renderer on that
   * canvas gets a dead context whose create* calls all return null. React's
   * StrictMode mounts effects twice in development, which made that a
   * guaranteed failure rather than a rare one. The context goes away with the
   * canvas when React unmounts it.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    if (gl.isContextLost()) return;
    gl.deleteTexture(this.texture);
    gl.deleteBuffer(this.buffer);
    gl.deleteProgram(this.program);
  }
}

/**
 * A small RGB sample of the frame, taken once, that the scopes grade on the CPU.
 * Scopes want the shape of the distribution, not every pixel, so this stays
 * small enough to re-grade at interactive rates without touching the GPU.
 */
export const SCOPE_SAMPLE_WIDTH = 240;

export function sampleFrame(image: CanvasImageSource, width: number, height: number): Float32Array | null {
  if (!width || !height) return null;
  const sampleWidth = Math.min(SCOPE_SAMPLE_WIDTH, width);
  const sampleHeight = Math.max(1, Math.round((sampleWidth * height) / width));
  const canvas = document.createElement('canvas');
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, sampleWidth, sampleHeight);

  let data: Uint8ClampedArray;
  try {
    data = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
  } catch {
    return null; // a tainted canvas; scopes go dark rather than throwing
  }

  // Store as 0..1 floats with the row width recorded, so the parade knows
  // which column of the picture each sample came from.
  const out = new Float32Array(sampleWidth * sampleHeight * 3 + 2);
  out[0] = sampleWidth;
  out[1] = sampleHeight;
  for (let i = 0, o = 2; i < data.length; i += 4, o += 3) {
    out[o] = data[i] / 255;
    out[o + 1] = data[i + 1] / 255;
    out[o + 2] = data[i + 2] / 255;
  }
  return out;
}
