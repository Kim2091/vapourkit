export type NvencEncoder = 'h264_nvenc' | 'hevc_nvenc' | 'av1_nvenc';
export interface EncodingSupport {
  available: boolean;
  category: 'ready' | 'driver' | 'libraries' | 'unsupported' | 'sessions' | 'format' | 'ffmpeg' | 'timeout' | 'unknown' | 'cancelled';
  message: string;
  details?: string;
}
export const NVENC_FORMATS: Record<string, string> = {
  'vs.YUV420P8': 'yuv420p', 'vs.YUV420P10': 'yuv420p10le', 'vs.YUV422P10': 'yuv422p10le',
  'vs.YUV444P8': 'yuv444p', 'vs.YUV444P10': 'yuv444p10le', 'vs.RGB24': 'rgb24',
};
