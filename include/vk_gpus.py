"""
vk_gpus.py - lists the machine's GPUs and finds one GPU's number in each API.

Every backend numbers GPUs its own way: DirectML takes a DXGI adapter index,
NCNN a Vulkan physical device index, TensorRT a CUDA device and MIGraphX a
HIP device, and the orders differ (DXGI puts the display adapter first, which
on a laptop is often the integrated GPU). So the app stores one physical GPU,
and each backend gets that GPU's number in its own API.

Run as a script, it prints the GPUs as JSON for the app's GPU picker. The
generated scripts import it through vk_runtime and look up the DXGI and Vulkan
numbers inside vspipe itself, because Windows can order adapters differently
per process (a per-app GPU preference reorders DXGI and, through it, the
Vulkan loader). CUDA and HIP are pinned by the app with CUDA_VISIBLE_DEVICES
and HIP_VISIBLE_DEVICES instead, which also covers their child processes.

Only ctypes is used, and each API is optional: a machine without a CUDA or HIP
driver just lists no CUDA or HIP numbers.
"""

import ctypes
import json
import sys

_WINDOWS = sys.platform == "win32"


def _load(*names):
    for name in names:
        try:
            return ctypes.WinDLL(name) if _WINDOWS else ctypes.CDLL(name)
        except OSError:
            continue
    return None


def _pci(domain, bus, device, function):
    return f"{domain:04x}:{bus:02x}:{device:02x}.{function:x}"


def _parse_pci(text):
    """Normalizes a CUDA/HIP bus id such as 00000000:01:00.0 to 0000:01:00.0."""
    try:
        head, function = text.strip().rsplit(".", 1)
        domain, bus, device = head.split(":")
        return _pci(int(domain, 16), int(bus, 16), int(device, 16), int(function, 16))
    except ValueError:
        return None


class _LUID(ctypes.Structure):
    _fields_ = [("LowPart", ctypes.c_uint32), ("HighPart", ctypes.c_int32)]


class _DXGI_ADAPTER_DESC1(ctypes.Structure):
    _fields_ = [
        ("Description", ctypes.c_wchar * 128),
        ("VendorId", ctypes.c_uint),
        ("DeviceId", ctypes.c_uint),
        ("SubSysId", ctypes.c_uint),
        ("Revision", ctypes.c_uint),
        ("DedicatedVideoMemory", ctypes.c_size_t),
        ("DedicatedSystemMemory", ctypes.c_size_t),
        ("SharedSystemMemory", ctypes.c_size_t),
        ("AdapterLuid", _LUID),
        ("Flags", ctypes.c_uint),
    ]


class _GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_uint32), ("Data2", ctypes.c_uint16),
                ("Data3", ctypes.c_uint16), ("Data4", ctypes.c_ubyte * 8)]


# IID_IDXGIFactory1 {770aae78-f26f-4dba-a829-253c83d1b387}
_IID_IDXGIFactory1 = _GUID(0x770AAE78, 0xF26F, 0x4DBA, (ctypes.c_ubyte * 8)(0xA8, 0x29, 0x25, 0x3C, 0x83, 0xD1, 0xB3, 0x87))
_DXGI_ADAPTER_FLAG_SOFTWARE = 2
_MICROSOFT_VENDOR = 0x1414


def _com_method(obj, index, restype, *argtypes):
    vtable = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    return ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(vtable[index])


def dxgi_adapters():
    """DXGI adapters in EnumAdapters1 order, which is DirectML's device_id."""
    if not _WINDOWS:
        return []
    dxgi = _load("dxgi")
    if dxgi is None:
        return []
    factory = ctypes.c_void_p()
    if dxgi.CreateDXGIFactory1(ctypes.byref(_IID_IDXGIFactory1), ctypes.byref(factory)) != 0:
        return []
    adapters = []
    try:
        # IDXGIFactory1::EnumAdapters1 is vtable slot 12; IDXGIAdapter1::GetDesc1 is 10.
        enum_adapters = _com_method(factory, 12, ctypes.c_long, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p))
        index = 0
        while True:
            adapter = ctypes.c_void_p()
            if enum_adapters(factory, index, ctypes.byref(adapter)) != 0:
                break
            desc = _DXGI_ADAPTER_DESC1()
            if _com_method(adapter, 10, ctypes.c_long, ctypes.POINTER(_DXGI_ADAPTER_DESC1))(adapter, ctypes.byref(desc)) == 0:
                adapters.append({
                    "index": index,
                    "name": desc.Description,
                    "vendorId": desc.VendorId,
                    "deviceId": desc.DeviceId,
                    "luid": f"{desc.AdapterLuid.HighPart & 0xFFFFFFFF:08x}{desc.AdapterLuid.LowPart:08x}",
                    "vramMB": desc.DedicatedVideoMemory // (1024 * 1024),
                    "software": bool(desc.Flags & _DXGI_ADAPTER_FLAG_SOFTWARE) or desc.VendorId == _MICROSOFT_VENDOR,
                })
            _com_method(adapter, 2, ctypes.c_ulong)(adapter)
            index += 1
    finally:
        _com_method(factory, 2, ctypes.c_ulong)(factory)
    return adapters


_VK_STRUCTURE_TYPE_APPLICATION_INFO = 0
_VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO = 1
_VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2 = 1000059001
_VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ID_PROPERTIES = 1000071004
_VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PCI_BUS_INFO_PROPERTIES_EXT = 1000212000
_VK_API_VERSION_1_1 = (1 << 22) | (1 << 12)
_VK_PHYSICAL_DEVICE_TYPE_CPU = 4
_VK_DEVICE_TYPES = {1: "integrated", 2: "discrete", 3: "virtual", 4: "cpu"}


class _VkApplicationInfo(ctypes.Structure):
    _fields_ = [("sType", ctypes.c_int), ("pNext", ctypes.c_void_p), ("pApplicationName", ctypes.c_char_p),
                ("applicationVersion", ctypes.c_uint32), ("pEngineName", ctypes.c_char_p),
                ("engineVersion", ctypes.c_uint32), ("apiVersion", ctypes.c_uint32)]


class _VkInstanceCreateInfo(ctypes.Structure):
    _fields_ = [("sType", ctypes.c_int), ("pNext", ctypes.c_void_p), ("flags", ctypes.c_uint32),
                ("pApplicationInfo", ctypes.POINTER(_VkApplicationInfo)),
                ("enabledLayerCount", ctypes.c_uint32), ("ppEnabledLayerNames", ctypes.c_void_p),
                ("enabledExtensionCount", ctypes.c_uint32), ("ppEnabledExtensionNames", ctypes.c_void_p)]


class _VkPhysicalDeviceIDProperties(ctypes.Structure):
    _fields_ = [("sType", ctypes.c_int), ("pNext", ctypes.c_void_p), ("deviceUUID", ctypes.c_ubyte * 16),
                ("driverUUID", ctypes.c_ubyte * 16), ("deviceLUID", ctypes.c_ubyte * 8),
                ("deviceNodeMask", ctypes.c_uint32), ("deviceLUIDValid", ctypes.c_uint32)]


class _VkPhysicalDevicePCIBusInfoProperties(ctypes.Structure):
    _fields_ = [("sType", ctypes.c_int), ("pNext", ctypes.c_void_p), ("pciDomain", ctypes.c_uint32),
                ("pciBus", ctypes.c_uint32), ("pciDevice", ctypes.c_uint32), ("pciFunction", ctypes.c_uint32)]


class _VkPhysicalDeviceProperties2(ctypes.Structure):
    # VkPhysicalDeviceProperties is read by offset, so the large limits struct
    # needs no declaration; the buffer only has to be at least as big.
    _fields_ = [("sType", ctypes.c_int), ("pNext", ctypes.c_void_p), ("properties", ctypes.c_ubyte * 1024)]


def _uuid_text(raw):
    hex_ = bytes(raw).hex()
    return f"{hex_[:8]}-{hex_[8:12]}-{hex_[12:16]}-{hex_[16:20]}-{hex_[20:]}"


def _has_device_extension(vk, device, name):
    count = ctypes.c_uint32()
    if vk.vkEnumerateDeviceExtensionProperties(device, None, ctypes.byref(count), None) != 0:
        return False
    # VkExtensionProperties is char extensionName[256] then uint32 specVersion.
    buffer = (ctypes.c_ubyte * (260 * count.value))()
    if vk.vkEnumerateDeviceExtensionProperties(device, None, ctypes.byref(count), buffer) != 0:
        return False
    raw = bytes(buffer)
    return any(raw[i * 260:i * 260 + 256].split(b"\0", 1)[0] == name for i in range(count.value))


def vulkan_devices():
    """Vulkan physical devices in enumeration order, which is NCNN's device_id."""
    vk = _load("vulkan-1") if _WINDOWS else _load("libvulkan.so.1", "libvulkan.so")
    if vk is None:
        return []
    vk.vkGetPhysicalDeviceProperties2.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    vk.vkGetPhysicalDeviceProperties2.restype = None
    vk.vkEnumerateDeviceExtensionProperties.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
    vk.vkEnumeratePhysicalDevices.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
    vk.vkDestroyInstance.argtypes = [ctypes.c_void_p, ctypes.c_void_p]

    app = _VkApplicationInfo(_VK_STRUCTURE_TYPE_APPLICATION_INFO, None, b"vapourkit", 1, b"vapourkit", 1, _VK_API_VERSION_1_1)
    info = _VkInstanceCreateInfo(_VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, None, 0, ctypes.pointer(app), 0, None, 0, None)
    instance = ctypes.c_void_p()
    if vk.vkCreateInstance(ctypes.byref(info), None, ctypes.byref(instance)) != 0:
        return []
    devices = []
    try:
        count = ctypes.c_uint32()
        vk.vkEnumeratePhysicalDevices(instance, ctypes.byref(count), None)
        handles = (ctypes.c_void_p * count.value)()
        vk.vkEnumeratePhysicalDevices(instance, ctypes.byref(count), handles)
        for index, handle in enumerate(handles[:count.value]):
            pci = _VkPhysicalDevicePCIBusInfoProperties(_VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PCI_BUS_INFO_PROPERTIES_EXT, None)
            has_pci = _has_device_extension(vk, handle, b"VK_EXT_pci_bus_info")
            ids = _VkPhysicalDeviceIDProperties(_VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ID_PROPERTIES,
                                                ctypes.cast(ctypes.pointer(pci), ctypes.c_void_p) if has_pci else None)
            props = _VkPhysicalDeviceProperties2(_VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2,
                                                 ctypes.cast(ctypes.pointer(ids), ctypes.c_void_p))
            vk.vkGetPhysicalDeviceProperties2(handle, ctypes.byref(props))
            raw = bytes(props.properties)
            vendor_id, device_id, device_type = (int.from_bytes(raw[o:o + 4], "little") for o in (8, 12, 16))
            devices.append({
                "index": index,
                "name": raw[20:276].split(b"\0", 1)[0].decode("utf-8", "replace"),
                "vendorId": vendor_id,
                "deviceId": device_id,
                "type": _VK_DEVICE_TYPES.get(device_type, "other"),
                "uuid": _uuid_text(ids.deviceUUID),
                "luid": bytes(reversed(bytes(ids.deviceLUID[4:8]))).hex() + bytes(reversed(bytes(ids.deviceLUID[0:4]))).hex()
                if ids.deviceLUIDValid else None,
                "pci": _pci(pci.pciDomain, pci.pciBus, pci.pciDevice, pci.pciFunction) if has_pci else None,
            })
    finally:
        vk.vkDestroyInstance(instance, None)
    return devices


def cuda_devices():
    """CUDA devices with the UUID that CUDA_VISIBLE_DEVICES accepts."""
    cuda = _load("nvcuda") if _WINDOWS else _load("libcuda.so.1", "libcuda.so")
    if cuda is None or cuda.cuInit(0) != 0:
        return []
    count = ctypes.c_int()
    if cuda.cuDeviceGetCount(ctypes.byref(count)) != 0:
        return []
    devices = []
    for ordinal in range(count.value):
        device = ctypes.c_int()
        if cuda.cuDeviceGet(ctypes.byref(device), ordinal) != 0:
            continue
        name = ctypes.create_string_buffer(256)
        cuda.cuDeviceGetName(name, 256, device)
        uuid = (ctypes.c_ubyte * 16)()
        get_uuid = getattr(cuda, "cuDeviceGetUuid_v2", None) or cuda.cuDeviceGetUuid
        bus = ctypes.create_string_buffer(64)
        luid = (ctypes.c_ubyte * 8)()
        node_mask = ctypes.c_uint()
        has_luid = _WINDOWS and cuda.cuDeviceGetLuid(luid, ctypes.byref(node_mask), device) == 0
        memory = ctypes.c_size_t()
        cuda.cuDeviceTotalMem_v2(ctypes.byref(memory), device)
        devices.append({
            "index": ordinal,
            "name": name.value.decode("utf-8", "replace"),
            "uuid": _uuid_text(uuid) if get_uuid(uuid, device) == 0 else None,
            "pci": _parse_pci(bus.value.decode()) if cuda.cuDeviceGetPCIBusId(bus, 64, device) == 0 else None,
            "luid": bytes(reversed(bytes(luid[4:8]))).hex() + bytes(reversed(bytes(luid[0:4]))).hex() if has_luid else None,
            "vramMB": memory.value // (1024 * 1024),
        })
    return devices


def hip_devices():
    """HIP devices, numbered as HIP_VISIBLE_DEVICES counts them."""
    hip = (_load("amdhip64_7", "amdhip64_6", "amdhip64") if _WINDOWS
           else _load("libamdhip64.so.7", "libamdhip64.so.6", "libamdhip64.so"))
    if hip is None or hip.hipInit(0) != 0:
        return []
    count = ctypes.c_int()
    if hip.hipGetDeviceCount(ctypes.byref(count)) != 0:
        return []
    devices = []
    for ordinal in range(count.value):
        name = ctypes.create_string_buffer(256)
        hip.hipDeviceGetName(name, 256, ordinal)
        bus = ctypes.create_string_buffer(64)
        devices.append({
            "index": ordinal,
            "name": name.value.decode("utf-8", "replace"),
            "pci": _parse_pci(bus.value.decode()) if hip.hipDeviceGetPCIBusId(bus, 64, ordinal) == 0 else None,
        })
    return devices


def _safely(probe):
    try:
        return probe()
    except Exception as error:  # a broken driver must not hide the other APIs
        print(f"vk_gpus: {probe.__name__} failed: {error}", file=sys.stderr)
        return []


def _same(a, b, key):
    return a.get(key) is not None and a.get(key) == b.get(key)


def list_gpus():
    """
    The physical GPUs, each with its number in every API that sees it.

    Vulkan is the base list because it reports LUID, PCI location and UUID, the
    keys the other APIs share: DXGI joins on LUID, CUDA on LUID, UUID or PCI
    location, HIP on PCI location. A GPU is listed in Vulkan order, and one
    only DXGI sees is added after.
    """
    gpus = []
    for device in _safely(vulkan_devices):
        if device["type"] == "cpu":
            continue
        twin = next((gpu for gpu in gpus if _same(gpu, device, "luid") or _same(gpu, device, "pci")), None)
        if twin is not None:
            # A layered driver (the Direct3D 12 "Dozen" one) lists the same GPU
            # again; the first, native entry keeps its number.
            continue
        gpus.append({
            "name": device["name"], "vendorId": device["vendorId"], "deviceId": device["deviceId"],
            "type": device["type"], "luid": device["luid"], "pci": device["pci"], "uuid": device["uuid"],
            "vramMB": None, "dxgi": None, "vulkan": device["index"], "cuda": None, "cudaUuid": None, "hip": None,
        })
    for adapter in _safely(dxgi_adapters):
        if adapter["software"]:
            continue
        gpu = next((gpu for gpu in gpus if _same(gpu, adapter, "luid")), None)
        if gpu is None:
            gpu = {"name": adapter["name"], "vendorId": adapter["vendorId"], "deviceId": adapter["deviceId"],
                   "type": None, "luid": adapter["luid"], "pci": None, "uuid": None,
                   "vramMB": None, "dxgi": None, "vulkan": None, "cuda": None, "cudaUuid": None, "hip": None}
            gpus.append(gpu)
        gpu["dxgi"] = adapter["index"]
        gpu["name"] = adapter["name"]
        gpu["vramMB"] = adapter["vramMB"]
    for device in _safely(cuda_devices):
        gpu = next((gpu for gpu in gpus if _same(gpu, device, "luid") or _same(gpu, device, "uuid")
                    or _same(gpu, device, "pci")), None)
        if gpu is not None:
            gpu["cuda"] = device["index"]
            gpu["cudaUuid"] = f"GPU-{device['uuid']}" if device["uuid"] else None
            gpu["pci"] = gpu["pci"] or device["pci"]
            gpu["vramMB"] = gpu["vramMB"] or device["vramMB"]
    for device in _safely(hip_devices):
        gpu = next((gpu for gpu in gpus if _same(gpu, device, "pci")), None)
        if gpu is not None:
            gpu["hip"] = device["index"]
    return gpus


def find_index(api, target):
    """
    The number `target` (a GPU from list_gpus, plus its "ordinal" among GPUs of
    the same model) has in `api`, "dxgi" or "vulkan", in the calling process;
    None when that API does not see it.

    A LUID only lasts until the next boot and not every driver reports a PCI
    location, so the GPU is found by LUID, then PCI location, then model, and
    between identical models the ordinal decides.
    """
    devices = [device for device in _safely(dxgi_adapters if api == "dxgi" else vulkan_devices)
               if not device.get("software") and device.get("type") != "cpu"]
    for key in ("luid", "pci"):
        if target.get(key):
            found = [device for device in devices if device.get(key) == target[key]]
            if found:
                return found[0]["index"]
    same_model = [device for device in devices
                  if device["vendorId"] == target.get("vendorId") and device["deviceId"] == target.get("deviceId")]
    ordinal = target.get("ordinal") or 0
    return same_model[ordinal]["index"] if ordinal < len(same_model) else None


if __name__ == "__main__":
    print(json.dumps(list_gpus()))
