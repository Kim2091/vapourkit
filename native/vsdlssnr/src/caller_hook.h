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
  // Ported from the dxvk-remix DLSS-NR integration, where this technique is already validated
  // against a running snippet.
  //
  // Returns the IAT slot that was written, for unhookCallerCheck to restore, or nullptr if
  // nothing was touched.
  void** hookCallerCheck(HMODULE snippet);

  // Restores the slot. Must run before the snippet is unmapped - the slot lives inside it.
  void unhookCallerCheck(void** slot);

} // namespace vsdlssnr
