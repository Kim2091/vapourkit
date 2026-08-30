cmake_minimum_required(VERSION 3.20)
project(vsdlssnr LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT WIN32)
  message(FATAL_ERROR "vsdlssnr is Windows-only: it drives nvngx_dlssnr.dll over D3D12.")
endif()

# The NGX SDK is only needed for the driver-core parameter block (Init_Ext /
# GetCapabilityParameters). Everything DLSS-NR specific is resolved out of the snippet at
# runtime, so no DLSS-NR SDK is required - NVIDIA does not publish one.
set(NGX_SDK_DIR "" CACHE PATH "Root of the NGX SDK (the directory containing include/ and lib/)")
set(VAPOURSYNTH_INCLUDE_DIR "" CACHE PATH "Directory containing VapourSynth4.h and VSHelper4.h")

if(NOT NGX_SDK_DIR)
  message(FATAL_ERROR "Set NGX_SDK_DIR to an NGX SDK root (see build.ps1 for the default).")
endif()

if(NOT VAPOURSYNTH_INCLUDE_DIR)
  message(FATAL_ERROR "Set VAPOURSYNTH_INCLUDE_DIR to the VapourSynth SDK include directory.")
endif()

# _d before _s: the suffix is the CRT the lib was built against, not how NGX itself links.
# nvsdk_ngx_s.lib is /MT and will not link into an /MD target - and /MD is what this has to be,
# since the plugin is loaded into a VapourSynth process that already uses the dynamic CRT.
find_library(NGX_LIBRARY
  NAMES nvsdk_ngx_d nvsdk_ngx_s
  PATHS "${NGX_SDK_DIR}/lib/Windows_x86_64/x64" "${NGX_SDK_DIR}/lib/x64"
  NO_DEFAULT_PATH
)

if(NOT NGX_LIBRARY)
  message(FATAL_ERROR "Could not find nvsdk_ngx_s.lib under ${NGX_SDK_DIR}")
endif()

add_library(vsdlssnr SHARED
  src/plugin.cpp
  src/d3d12_ctx.cpp
  src/ngx_uplift.cpp
  src/caller_hook.cpp
  src/log.cpp
)

target_include_directories(vsdlssnr PRIVATE
  "${NGX_SDK_DIR}/include"
  "${VAPOURSYNTH_INCLUDE_DIR}"
  src
)

target_link_libraries(vsdlssnr PRIVATE
  "${NGX_LIBRARY}"
  d3d12
  dxgi
  advapi32
  shell32
  ole32
  user32
  version
)

target_compile_definitions(vsdlssnr PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  UNICODE
  _UNICODE
)

if(MSVC)
  target_compile_options(vsdlssnr PRIVATE /W4 /permissive- /EHsc)
  # The NGX static lib is built against the dynamic CRT.
  set_property(TARGET vsdlssnr PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreadedDLL")
endif()

set_target_properties(vsdlssnr PROPERTIES
  OUTPUT_NAME "vsdlssnr"
  PREFIX ""
)
