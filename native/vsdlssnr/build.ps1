# Builds vsdlssnr.dll and, with -Install, drops it into the Vapourkit VapourSynth plugin folder.
#
# Requires Visual Studio 2022 (any edition with the C++ workload). Uses the CMake and Ninja that
# ship inside the VS install, so nothing else has to be on PATH.

param(
  [string]$Config = "Release",
  [string]$NgxSdkDir = "C:\Users\sparkles\Projects\Fable_5_testing\dxvk-remix-dlss5\external\ngx_sdk_dldn",
  [string]$VapourSynthIncludeDir = "C:\Users\sparkles\Projects\vapourkit\data\vapoursynth-portable\Lib\site-packages\vapoursynth\include",
  [switch]$Install
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildDir = Join-Path $root "build"

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { throw "vswhere.exe was not found; is Visual Studio installed?" }

$vsRoot = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsRoot) { throw "Visual Studio with the C++ toolset was not found." }
$vsRoot = @($vsRoot)[0]

$cmake = Join-Path $vsRoot "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
$ninja = Join-Path $vsRoot "Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"
$vcvars = Join-Path $vsRoot "VC\Auxiliary\Build\vcvars64.bat"

foreach ($tool in @($cmake, $ninja, $vcvars)) {
  if (-not (Test-Path $tool)) { throw "Missing build tool: $tool" }
}

if (-not (Test-Path $NgxSdkDir)) { throw "NGX SDK not found at $NgxSdkDir" }
if (-not (Test-Path $VapourSynthIncludeDir)) { throw "VapourSynth headers not found at $VapourSynthIncludeDir" }

# vcvars64 only sets the environment for the process it starts, so configure and build both run
# inside one cmd invocation rather than trying to import the variables back out.
$configure = @(
  "`"$cmake`"",
  "-G Ninja",
  "-DCMAKE_MAKE_PROGRAM=`"$ninja`"",
  "-DCMAKE_BUILD_TYPE=$Config",
  "-DNGX_SDK_DIR=`"$($NgxSdkDir -replace '\\','/')`"",
  "-DVAPOURSYNTH_INCLUDE_DIR=`"$($VapourSynthIncludeDir -replace '\\','/')`"",
  "-S `"$root`"",
  "-B `"$buildDir`""
) -join " "

$build = "`"$cmake`" --build `"$buildDir`""

# The VS18 Build Tools vcvars64.bat shells out to vswhere.exe by bare name and fails if it is
# not on PATH, which it is not in a non-interactive cmd. Prepend the Installer directory.
$installerDir = Split-Path -Parent $vswhere

& cmd.exe /c "set `"PATH=$installerDir;%PATH%`" && `"$vcvars`" >nul && $configure && $build"
if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE" }

$dll = Join-Path $buildDir "vsdlssnr.dll"
if (-not (Test-Path $dll)) { throw "Build reported success but $dll is missing" }

Write-Host "Built $dll"

if ($Install) {
  $pluginDir = Join-Path (Split-Path -Parent $VapourSynthIncludeDir) "plugins"
  if (-not (Test-Path $pluginDir)) { New-Item -ItemType Directory -Path $pluginDir | Out-Null }
  Copy-Item $dll (Join-Path $pluginDir "vsdlssnr.dll") -Force
  Write-Host "Installed to $pluginDir"
  Write-Host "Place nvngx_dlssnr.dll in that folder as well - it is not shipped with the driver."
}
