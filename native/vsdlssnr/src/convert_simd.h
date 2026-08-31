#pragma once

#include <cstdint>

namespace vsdlssnr {

  // AVX2 + F16C planar<->packed conversion for the RGBS (32-bit float) case, which is the
  // documented and overwhelmingly common input format.
  //
  // These exist because DirectXMath's XMConvertFloatToHalf compiles to its *software* path
  // unless the whole translation unit is built with /arch:AVX2, and this plugin cannot be:
  // it has to load on any x64 CPU. Twenty-five million software float->half conversions per
  // 4K frame was the larger half of the CPU cost, not the memory traffic. The hardware
  // instruction (VCVTPS2PH) does eight at a time in a few cycles.
  //
  // Only convert_simd.cpp is compiled with /arch:AVX2. Nothing here may be called without
  // first checking hasAvx2F16c(), which lives in a baseline translation unit on purpose.
  bool hasAvx2F16c();

  // One row, planar float RGB -> packed RGBA16F with alpha = 1.0. Values are clamped to 0..1;
  // a NaN is passed through to the conversion exactly as the scalar path does.
  void packRowRgbaHalfAvx2(const float* r,
                           const float* g,
                           const float* b,
                           uint64_t* dst,
                           int width);

  // One row, packed RGBA16F -> three planar float rows. Alpha is dropped.
  void unpackRowRgbaHalfAvx2(const uint16_t* src,
                             float* r,
                             float* g,
                             float* b,
                             int width);

} // namespace vsdlssnr
