// AVX2 + F16C row conversions. THIS FILE IS COMPILED WITH /arch:AVX2 - nothing else is, and
// nothing in here may be called without hasAvx2F16c() having returned true. That check lives
// in plugin.cpp, a baseline translation unit, because a CPUID probe compiled with /arch:AVX2
// could itself be given AVX2 instructions by the optimizer and fault before it could answer.

#include "convert_simd.h"

#include <immintrin.h>

#include <cstdint>
#include <cstring>

namespace vsdlssnr {

  namespace {

    // std::clamp(v, 0.0f, 1.0f) returns v when v is NaN, while _mm256_max_ps(v, zero) returns
    // zero. The scalar path this replaces passes NaN into the conversion, so blend it back to
    // keep the two bitwise identical on every input rather than only on well-formed frames.
    inline __m256 clamp01(__m256 v) {
      const __m256 zero = _mm256_setzero_ps();
      const __m256 one = _mm256_set1_ps(1.0f);
      const __m256 unordered = _mm256_cmp_ps(v, v, _CMP_UNORD_Q);
      const __m256 clamped = _mm256_min_ps(_mm256_max_ps(v, zero), one);
      return _mm256_blendv_ps(clamped, v, unordered);
    }

    // VCVTPS2PH's imm8 is three bits: bit 2 selects MXCSR, bits 1:0 the rounding mode.
    // _MM_FROUND_NO_EXC (8) does not fit and is not meaningful here. 0 is round-to-nearest-even,
    // which is what DirectXMath's software path implements.
    constexpr int kRound = _MM_FROUND_TO_NEAREST_INT;

  } // namespace

  void packRowRgbaHalfAvx2(const float* r,
                           const float* g,
                           const float* b,
                           uint64_t* dst,
                           int width) {
    // Alpha is a constant 1.0h and rides along inside the same stores, so it is free.
    const __m128i alpha = _mm_set1_epi16(static_cast<short>(0x3C00));

    int x = 0;
    for (; x + 8 <= width; x += 8) {
      const __m128i rh = _mm256_cvtps_ph(clamp01(_mm256_loadu_ps(r + x)), kRound);
      const __m128i gh = _mm256_cvtps_ph(clamp01(_mm256_loadu_ps(g + x)), kRound);
      const __m128i bh = _mm256_cvtps_ph(clamp01(_mm256_loadu_ps(b + x)), kRound);

      const __m128i rgLo = _mm_unpacklo_epi16(rh, gh);
      const __m128i rgHi = _mm_unpackhi_epi16(rh, gh);
      const __m128i baLo = _mm_unpacklo_epi16(bh, alpha);
      const __m128i baHi = _mm_unpackhi_epi16(bh, alpha);

      const __m128i p01 = _mm_unpacklo_epi32(rgLo, baLo);
      const __m128i p23 = _mm_unpackhi_epi32(rgLo, baLo);
      const __m128i p45 = _mm_unpacklo_epi32(rgHi, baHi);
      const __m128i p67 = _mm_unpackhi_epi32(rgHi, baHi);

      // Two sequential 32-byte stores. The destination is a write-combined upload heap, where
      // full-width sequential stores are the only ones that reach full bandwidth.
      auto* out = reinterpret_cast<__m256i*>(dst + x);
      _mm256_storeu_si256(out, _mm256_setr_m128i(p01, p23));
      _mm256_storeu_si256(out + 1, _mm256_setr_m128i(p45, p67));
    }

    for (; x < width; ++x) {
      const __m128 rv = _mm_set_ss(r[x]);
      const __m128 gv = _mm_set_ss(g[x]);
      const __m128 bv = _mm_set_ss(b[x]);
      const __m256 packed = _mm256_setr_ps(_mm_cvtss_f32(rv), _mm_cvtss_f32(gv),
                                           _mm_cvtss_f32(bv), 1.0f, 0, 0, 0, 0);
      const __m128i halves = _mm256_cvtps_ph(clamp01(packed), kRound);
      uint16_t lanes[8];
      _mm_storeu_si128(reinterpret_cast<__m128i*>(lanes), halves);
      dst[x] = static_cast<uint64_t>(lanes[0]) | (static_cast<uint64_t>(lanes[1]) << 16) |
               (static_cast<uint64_t>(lanes[2]) << 32) | (static_cast<uint64_t>(0x3C00) << 48);
    }
  }

  void unpackRowRgbaHalfAvx2(const uint16_t* src,
                             float* r,
                             float* g,
                             float* b,
                             int width) {
    // Gathers the four 16-bit channels of two pixels into channel order within each 128-bit
    // block: [r0 r1 g0 g1 b0 b1 a0 a1].
    const __m128i gather = _mm_setr_epi8(0, 1, 8, 9, 2, 3, 10, 11, 4, 5, 12, 13, 6, 7, 14, 15);

    // Non-temporal stores need 32-byte alignment. VapourSynth aligns plane data and strides
    // generously, but a caller could always hand over something else, so check rather than
    // assume: a misaligned MOVNTPS faults.
    constexpr uintptr_t kAlign = 31;
    const bool streaming = ((reinterpret_cast<uintptr_t>(r) | reinterpret_cast<uintptr_t>(g) |
                             reinterpret_cast<uintptr_t>(b)) & kAlign) == 0;

    int x = 0;
    for (; x + 8 <= width; x += 8) {
      const auto* in = reinterpret_cast<const __m128i*>(src + x * 4);
      const __m128i a = _mm_shuffle_epi8(_mm_loadu_si128(in + 0), gather);
      const __m128i c = _mm_shuffle_epi8(_mm_loadu_si128(in + 1), gather);
      const __m128i e = _mm_shuffle_epi8(_mm_loadu_si128(in + 2), gather);
      const __m128i f = _mm_shuffle_epi8(_mm_loadu_si128(in + 3), gather);

      const __m128i rgAC = _mm_unpacklo_epi32(a, c); // r0 r1 r2 r3 g0 g1 g2 g3
      const __m128i rgEF = _mm_unpacklo_epi32(e, f); // r4 r5 r6 r7 g4 g5 g6 g7
      const __m128i baAC = _mm_unpackhi_epi32(a, c); // b0 b1 b2 b3 a0 a1 a2 a3
      const __m128i baEF = _mm_unpackhi_epi32(e, f);

      const __m256 rf = _mm256_cvtph_ps(_mm_unpacklo_epi64(rgAC, rgEF));
      const __m256 gf = _mm256_cvtph_ps(_mm_unpackhi_epi64(rgAC, rgEF));
      const __m256 bf = _mm256_cvtph_ps(_mm_unpacklo_epi64(baAC, baEF));

      if (streaming) {
        // The destination plane is ~33 MB per channel at 4K and is never read again by this
        // thread. An ordinary store pulls each line into cache first (read-for-ownership),
        // which costs a second pass over the whole frame in DRAM traffic for nothing.
        _mm256_stream_ps(r + x, rf);
        _mm256_stream_ps(g + x, gf);
        _mm256_stream_ps(b + x, bf);
      } else {
        _mm256_storeu_ps(r + x, rf);
        _mm256_storeu_ps(g + x, gf);
        _mm256_storeu_ps(b + x, bf);
      }
    }

    for (; x < width; ++x) {
      const __m128i one = _mm_loadl_epi64(reinterpret_cast<const __m128i*>(src + x * 4));
      float lanes[4];
      _mm_storeu_ps(lanes, _mm_cvtph_ps(one));
      r[x] = lanes[0];
      g[x] = lanes[1];
      b[x] = lanes[2];
    }

    // Non-temporal stores are weakly ordered against everything else. One fence per row is far
    // below the noise floor and keeps the guarantee local to this function.
    if (streaming) {
      _mm_sfence();
    }
  }

} // namespace vsdlssnr
