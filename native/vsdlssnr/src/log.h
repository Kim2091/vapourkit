#pragma once

#include <string>

namespace vsdlssnr {

  // Diagnostics go to the debugger and to stderr. VapourSynth gives a filter no logging
  // channel outside of frame errors, and the interesting failures here (a snippet that will
  // not load, a feature that will not create) happen at Create time where the only channel is
  // the error string - which carries one line. The detail goes here instead.
  void logInfo(const std::string& message);
  void logWarn(const std::string& message);

} // namespace vsdlssnr
