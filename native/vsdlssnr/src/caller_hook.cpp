#include "caller_hook.h"

#include "log.h"

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <mutex>

namespace vsdlssnr {

  namespace {

    using PFN_GetModuleFileNameW = DWORD (WINAPI*)(HMODULE, LPWSTR, DWORD);

    // Hook state has to live at file scope: the replacement is a plain WINAPI function with no
    // room to carry any. Process-wide is accurate rather than merely convenient - there is one
    // snippet, loaded once, shared by every filter instance in the process.
    PFN_GetModuleFileNameW g_realGetModuleFileNameW = nullptr;
    HMODULE g_spoofedModule = nullptr;

    // Length of L"nvngx.dll" without its terminator, i.e. what GetModuleFileNameW returns on
    // success. The snippet only takes the basename, so a bare filename is as good as a path.
    constexpr DWORD kNvngxFileNameLength = 9;

    DWORD WINAPI spoofedGetModuleFileNameW(HMODULE hModule, LPWSTR lpFilename, DWORD nSize) {
      if (nSize != 0 && lpFilename != nullptr && hModule == g_spoofedModule && g_spoofedModule != nullptr) {
        // Same truncation contract as the real function: too small a buffer is an error, not a
        // partial name, and reporting success here would hand the caller whatever the check
        // compares against next.
        if (nSize <= kNvngxFileNameLength) {
          lpFilename[0] = L'\0';
          SetLastError(ERROR_INSUFFICIENT_BUFFER);
          return nSize;
        }

        memcpy(lpFilename, L"nvngx.dll", (kNvngxFileNameLength + 1) * sizeof(wchar_t));
        return kNvngxFileNameLength;
      }

      return g_realGetModuleFileNameW(hModule, lpFilename, nSize);
    }

  // Installs the hook. Returns the IAT slot written, or nullptr if nothing was touched.
  void** installHook(HMODULE snippet) {
    auto* const base = reinterpret_cast<uint8_t*>(snippet);

    // The image is walked defensively throughout. Nothing here is trusted to be well formed:
    // an unexpected PE has to make this give up with the snippet unmodified, because the
    // alternative is faulting somewhere in the middle of a traversal.
    const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) {
      return nullptr;
    }

    // The image size that bounds everything below is itself in the NT headers, so those are
    // bounded by the one thing known without them: a mapped image's headers are covered by
    // SizeOfHeaders, which section alignment rounds up to at least one page.
    constexpr LONG kHeaderWindow = 0x1000;
    if (dos->e_lfanew < static_cast<LONG>(sizeof(IMAGE_DOS_HEADER)) ||
        dos->e_lfanew > kHeaderWindow - static_cast<LONG>(sizeof(IMAGE_NT_HEADERS))) {
      return nullptr;
    }

    const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS*>(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE ||
        nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR_MAGIC) {
      return nullptr;
    }

    const uint32_t imageSize = nt->OptionalHeader.SizeOfImage;

    // Every RVA dereferenced below goes through this first. Written as a subtraction rather
    // than rva + size <= imageSize so that a hostile RVA cannot wrap the addition.
    const auto rvaFits = [imageSize](uint32_t rva, size_t size) {
      return rva != 0 && size <= imageSize && rva <= imageSize - size;
    };

    if (nt->OptionalHeader.NumberOfRvaAndSizes <= IMAGE_DIRECTORY_ENTRY_IMPORT) {
      return nullptr;
    }

    const IMAGE_DATA_DIRECTORY& importDir =
      nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!rvaFits(importDir.VirtualAddress, sizeof(IMAGE_IMPORT_DESCRIPTOR))) {
      return nullptr;
    }

    for (uint32_t descriptorRva = importDir.VirtualAddress;
         rvaFits(descriptorRva, sizeof(IMAGE_IMPORT_DESCRIPTOR));
         descriptorRva += static_cast<uint32_t>(sizeof(IMAGE_IMPORT_DESCRIPTOR))) {
      const auto* descriptor = reinterpret_cast<const IMAGE_IMPORT_DESCRIPTOR*>(base + descriptorRva);

      // The import table is terminated by an all-zero descriptor.
      if (descriptor->FirstThunk == 0 && descriptor->OriginalFirstThunk == 0) {
        break;
      }

      // Names are read from the original thunk array, which the loader leaves alone; the
      // parallel FirstThunk array is what it overwrote with resolved addresses, and is what
      // gets rewritten. Some linkers emit only FirstThunk, in which case it served as both
      // before the loader got to it and the name is no longer recoverable from it - such a
      // descriptor is skipped rather than guessed at.
      if (descriptor->OriginalFirstThunk == 0 || descriptor->FirstThunk == 0) {
        continue;
      }

      // Thunk offsets are accumulated in 64 bits and range-checked before being narrowed:
      // computed in 32 they could wrap back into the image and turn a malformed table into an
      // endless walk rather than a clean give-up.
      for (uint64_t thunkOffset = 0;; thunkOffset += sizeof(IMAGE_THUNK_DATA)) {
        const uint64_t nameThunkRva = descriptor->OriginalFirstThunk + thunkOffset;
        if (nameThunkRva > imageSize ||
            !rvaFits(static_cast<uint32_t>(nameThunkRva), sizeof(IMAGE_THUNK_DATA))) {
          break;
        }

        const auto* nameThunk = reinterpret_cast<const IMAGE_THUNK_DATA*>(base + nameThunkRva);
        if (nameThunk->u1.AddressOfData == 0) {
          break;
        }

        // Ordinal imports carry no name to match against.
        if (IMAGE_SNAP_BY_ORDINAL(nameThunk->u1.Ordinal)) {
          continue;
        }

        static constexpr char kImportName[] = "GetModuleFileNameW";

        // The bound includes the terminator, so the comparison below cannot run off the end of
        // the image and matches the whole name rather than a prefix of a longer one.
        const uint64_t nameRva = nameThunk->u1.AddressOfData + offsetof(IMAGE_IMPORT_BY_NAME, Name);
        if (nameRva + sizeof(kImportName) > imageSize) {
          continue;
        }

        if (memcmp(base + nameRva, kImportName, sizeof(kImportName)) != 0) {
          continue;
        }

        const uint64_t slotRva = descriptor->FirstThunk + thunkOffset;
        if (slotRva > imageSize || !rvaFits(static_cast<uint32_t>(slotRva), sizeof(void*))) {
          return nullptr;
        }

        auto** slot = reinterpret_cast<void**>(base + slotRva);

        // Which module the snippet must be told about is decided here rather than at call
        // time: the return address it walks back to lands in whichever of our functions called
        // the export, so the module to spoof is the one this code is in.
        HMODULE ourModule = nullptr;
        if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                                  GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                                reinterpret_cast<LPCWSTR>(&spoofedGetModuleFileNameW),
                                &ourModule) ||
            ourModule == nullptr) {
          logWarn("Could not identify this module; the caller check was left in place");
          return nullptr;
        }

        // Guard against hooking the hook, which would recurse forever. Cannot happen with a
        // single load, but the state is process-wide and the cost of being wrong is a hang.
        if (*slot == reinterpret_cast<void*>(&spoofedGetModuleFileNameW)) {
          return nullptr;
        }

        DWORD oldProtect = 0;
        if (!VirtualProtect(slot, sizeof(void*), PAGE_READWRITE, &oldProtect)) {
          logWarn("Could not unprotect the snippet's import table; the caller check was left in place");
          return nullptr;
        }

        g_realGetModuleFileNameW = reinterpret_cast<PFN_GetModuleFileNameW>(*slot);
        g_spoofedModule = ourModule;
        *slot = reinterpret_cast<void*>(&spoofedGetModuleFileNameW);

        VirtualProtect(slot, sizeof(void*), oldProtect, &oldProtect);
        FlushInstructionCache(GetCurrentProcess(), slot, sizeof(void*));

        logInfo("Caller check bypassed: the snippet's GetModuleFileNameW import now reports this "
                "module as nvngx.dll");
        return slot;
      }
    }

    logWarn("The snippet does not import GetModuleFileNameW - the caller check could not be "
            "bypassed and the snippet is expected to reject calls from this module");
    return nullptr;
  }

  void restoreHook(void** slot) {
    if (slot == nullptr || g_realGetModuleFileNameW == nullptr) {
      return;
    }

    DWORD oldProtect = 0;
    if (!VirtualProtect(slot, sizeof(void*), PAGE_READWRITE, &oldProtect)) {
      return;
    }

    *slot = reinterpret_cast<void*>(g_realGetModuleFileNameW);

    VirtualProtect(slot, sizeof(void*), oldProtect, &oldProtect);
    FlushInstructionCache(GetCurrentProcess(), slot, sizeof(void*));

    g_realGetModuleFileNameW = nullptr;
    g_spoofedModule = nullptr;
  }

  // Guards the pair below. Contention is nil - this runs at filter create and destroy - but the
  // state is process-wide and VapourSynth builds filter graphs from more than one thread.
  std::mutex g_bypassMutex;
  int g_bypassRefCount = 0;
  void** g_bypassSlot = nullptr;

  } // namespace

  bool acquireCallerCheckBypass(HMODULE snippet) {
    std::lock_guard<std::mutex> guard(g_bypassMutex);

    if (g_bypassRefCount > 0) {
      // Already installed by an earlier instance against the same module: the snippet is loaded
      // once per process, so there is nothing to install again, only a reference to add.
      ++g_bypassRefCount;
      return true;
    }

    g_bypassSlot = installHook(snippet);
    if (g_bypassSlot == nullptr) {
      return false;
    }

    g_bypassRefCount = 1;
    return true;
  }

  void releaseCallerCheckBypass() {
    std::lock_guard<std::mutex> guard(g_bypassMutex);

    if (g_bypassRefCount == 0) {
      return;
    }

    if (--g_bypassRefCount > 0) {
      // Another instance is still driving the snippet; restoring now would break it.
      return;
    }

    restoreHook(g_bypassSlot);
    g_bypassSlot = nullptr;
  }

} // namespace vsdlssnr
