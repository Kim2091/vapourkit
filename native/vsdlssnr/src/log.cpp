#include "log.h"

#include <windows.h>

#include <cstdio>

namespace vsdlssnr {

  namespace {
    void emit(const char* level, const std::string& message) {
      const std::string line = std::string("[vsdlssnr] ") + level + ": " + message + "\n";
      OutputDebugStringA(line.c_str());
      std::fputs(line.c_str(), stderr);
      std::fflush(stderr);
    }
  }

  void logInfo(const std::string& message) {
    emit("info", message);
  }

  void logWarn(const std::string& message) {
    emit("warn", message);
  }

} // namespace vsdlssnr
