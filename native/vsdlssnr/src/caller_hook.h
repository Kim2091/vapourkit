#pragma once

#include <windows.h>

namespace vsdlssnr {

  // Redirects the snippet's GetModuleFileNameW import so its caller-origin check sees this
  // module as the driver's nvngx.dll.
  //
  // Every export in nvngx_dlssnr.dll refuses with FAIL_PlatformError unless the call arrives
  // from the driver's own nvngx.dll, and the installed driver does not know this feature at
  // all, so without this the snippet is unreachable. The check identifies its caller by asking
  // GetModuleFileNameW for the path of the module the return address lands in, so what this
  // redirects is that import: the snippet's own copy of the function answers "nvngx.dll" when
  // asked about this module, and passes every other query through. The snippet's code is not
  // modified.
  //
  // The hook is REFERENCE COUNTED because it is process-wide while its callers are not. The
  // snippet is loaded once no matter how many filter instances exist - LoadLibraryW hands every
  // caller after the first the same already-hooked module - so tying the hook's lifetime to
  // whichever instance happened to install it means destroying that instance silently breaks
  // every other live one, which then fails at EvaluateFeature with FAIL_PlatformError. Install
  // on the first acquire, restore on the last release.
  //
  // Ported from the dxvk-remix DLSS-NR integration, where a single owning object made a plain
  // install/restore pair correct.

  // Returns false when the hook could not be installed, in which case the caller holds nothing
  // and must not call release.
  bool acquireCallerCheckBypass(HMODULE snippet);

  // Restores the import when the last holder releases it. Every holder must call this before
  // the snippet is unmapped - the slot it points into disappears with the module.
  void releaseCallerCheckBypass();

} // namespace vsdlssnr
