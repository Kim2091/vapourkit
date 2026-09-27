# build/installer.nsh
#
# Custom NSIS, picked up automatically by electron-builder (its `nsis.include`
# option defaults to this path). It replaces exactly one step of the generated
# script: how the previous version's files are removed.
#
# WHY THIS EXISTS
#
# $INSTDIR\data is the VapourSynth/Python environment the app builds on first
# run - around 10,000 files and several GB, including torch's vendored licence
# tree, whose deepest paths run past 260 characters.
#
# electron-builder's default removal cannot cope with that. An update runs the
# OLD version's uninstaller with --updated, which takes the "atomic" branch:
# every file under $INSTDIR is RENAMED into %TEMP%\ns...tmp\old-install before
# anything is deleted, so a failure can be rolled back. NSIS carries no
# longPathAware entry in its manifest, so a machine-wide LongPathsEnabled does
# not reach it and MAX_PATH still applies - and re-rooting those torch paths
# under %TEMP% makes them longer again. The first rename over the limit fails,
# the uninstaller aborts non-zero, and the installer retries five times before
# reporting
#
#     "Vapourkit can't be closed. Please close it manually and click Retry."
#
# which is not what happened. Nothing is running; a file could not be moved.
# Retry runs the identical uninstall, so the message never clears.
#
# That same shuffle also destroyed the environment on every SUCCESSFUL update,
# because the staging directory is deleted at the end. That is what made an
# update cost the full 20+ minute setup, and why copying a new portable build
# over an old one has been the faster path for most people.
#
# Note the limit of this: the uninstaller that runs during an update belongs to
# the version being replaced, so customRemoveFiles only takes effect for updates
# FROM a build that shipped this file. Updates from 2.0.0 and the nightlies
# before it still run the stock uninstaller - see "CARRYING data\ ACROSS AN
# UPDATE" below for how the INSTALLER covers that hop.

!macro customRemoveFiles
  # Never leave the working directory inside the tree being removed.
  SetOutPath $TEMP

  ${if} ${isUpdated}
    # Update in place. The incoming payload overwrites every top-level file, so
    # only the two directories carrying version-specific content need clearing
    # - resources\ especially, since a filter template or bundled model dropped
    # in a release has to actually disappear rather than linger. data\ is not
    # touched, so the environment survives the update and nothing walks those
    # long paths at all. checkDependencies() reconciles the rest on first
    # launch: it already re-syncs bundled files whenever the version changes.
    RMDir /r "$INSTDIR\locales"
    RMDir /r "$INSTDIR\resources"
  ${else}
    # A real uninstall: the environment goes too. RMDir /r cannot reach the
    # over-length paths inside data\, so on its own it leaves the folder
    # behind. robocopy IS long-path aware, and mirroring an empty directory
    # over data\ empties it first. /R:0 /W:0 so a locked file fails at once
    # instead of retrying for a million seconds. Its exit code is ignored on
    # purpose: if robocopy is somehow unavailable, RMDir /r still clears
    # everything within MAX_PATH, which is exactly the old behaviour.
    ${if} ${FileExists} "$INSTDIR\data\*.*"
      Push $0
      RMDir /r "$TEMP\vk-uninstall-empty"
      CreateDirectory "$TEMP\vk-uninstall-empty"
      nsExec::Exec `"$SYSDIR\robocopy.exe" "$TEMP\vk-uninstall-empty" "$INSTDIR\data" /MIR /NJH /NJS /NP /NFL /NDL /R:0 /W:0`
      Pop $0
      RMDir "$TEMP\vk-uninstall-empty"
      Pop $0
    ${endif}
    RMDir /r "$INSTDIR"
  ${endif}
!macroend

# CARRYING data\ ACROSS AN UPDATE
#
# customRemoveFiles above lives in the uninstaller, and the uninstaller that
# runs during an update is the OLD version's. So when 2.0.0 (or a nightly
# before this file existed) is updated, the stock atomicRMDir still walks
# data\ and still fails on the first over-length path. Nothing in the old
# uninstaller can be changed after the fact; the only code we control on that
# hop is this installer.
#
# So the installer moves data\ out of the way before the old uninstaller ever
# sees it, and moves it back once the new files are in place:
#
#   1. customCheckAppRunning - the last hook electron-builder calls before
#      uninstallOldVersion (installSection.nsh). After the stock running-app
#      check, data\ is RENAMED to a sibling of the install folder,
#      "<install folder>.update-data". It is a single directory rename on the
#      same volume: nothing walks the tree, so path length never comes into
#      it, and it takes milliseconds however many GB the environment is.
#   2. The old uninstaller runs against an install folder with no data\ in it,
#      so its atomic shuffle only meets short paths and succeeds.
#   3. customInstall - called after the new files are extracted - renames the
#      carry folder back into $INSTDIR\data.
#
# Every failure is designed to end in "the carry folder is left where it is",
# never in deleting anything: a carried data\ may be the user's only copy of a
# 20-minute setup, and a later installer run finds it again. Recovery points:
#
#   - The old uninstaller fails anyway: customUnInstallCheck (below) moves the
#     carry folder back into the old install before quitting, so the machine
#     is left exactly as it was.
#   - The installer dies some other way after the carry (7z extraction
#     cancelled, process killed, power lost): the carry folder survives. The
#     old uninstaller has usually deleted the registry keys by then, so the
#     next run cannot learn the old location from them - which is why
#     customInstall also looks for "$INSTDIR.update-data". The default
#     $INSTDIR on that next run is the same per-user folder, so it is found.
#   - .onInstFailed is NOT used: every failure path in electron-builder's
#     install section ends in Quit, which skips it, and .onUserAbort belongs
#     to MUI2 and cannot fire once the install page is running anyway.
#
# Known gap: when the assisted installer runs as a UAC-elevated inner instance
# (a per-machine install), electron-builder skips CHECK_APP_RUNNING entirely,
# so no carry happens and such an update behaves as before. Vapourkit sets
# perMachine: false and allowElevation: false, so that path is not reachable
# in the shipped configuration.

# The stock definitions CHECK_APP_RUNNING relies on are only pulled in when
# customCheckAppRunning is NOT defined (allowOnlyOneInstallerInstance.nsh), so
# defining it means including them here - for both the installer and the
# uninstaller build, since the uninstaller's un.checkAppRunning expands the
# same macro. getProcessInfo.nsh picks _GetProcessInfo or un._GetProcessInfo
# from BUILD_UNINSTALLER by itself.
!include "LogicLib.nsh"
!include "getProcessInfo.nsh"
Var pid

!ifndef BUILD_UNINSTALLER
  # Where the previous install lives, per its registry keys. Empty when there
  # is no previous install or it could not be located.
  Var vkOldInstallDir
  # "<old install folder>.update-data", or empty.
  Var vkCarryDir
  # "1" only if THIS run moved data\ out, so a failure only ever undoes this
  # run's own move.
  Var vkCarried
!endif

!macro customCheckAppRunning
  # Exactly the stock behaviour first: the carry must never happen while the
  # app may still have files open in data\.
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING

  !ifndef BUILD_UNINSTALLER
    !insertmacro vkCarryDataOut
  !endif
!macroend

!macro vkCarryDataOut
  Push $R0
  StrCpy $vkOldInstallDir ""
  StrCpy $vkCarryDir ""
  StrCpy $vkCarried "0"

  # Locate the old install the same way uninstallOldVersion does, so data\ is
  # moved out of precisely the folder its uninstaller is about to process:
  # InstallLocation first, else the folder holding the uninstaller named in
  # UninstallString.
  ReadRegStr $vkOldInstallDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $vkOldInstallDir == ""
    ReadRegStr $R0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ${if} $R0 != ""
      !insertmacro GetInQuotes $R0 "$R0"
      ${if} $R0 != ""
        Push $R0
        Call GetFileParent
        Pop $vkOldInstallDir
      ${endif}
    ${endif}
  ${endif}

  ${if} $vkOldInstallDir != ""
    # A trailing backslash would make the carry name "...\Vapourkit\.update-data",
    # i.e. INSIDE the folder about to be uninstalled.
    StrCpy $R0 $vkOldInstallDir 1 -1
    ${if} $R0 == "\"
      StrCpy $vkOldInstallDir $vkOldInstallDir -1
    ${endif}
    StrCpy $vkCarryDir "$vkOldInstallDir.update-data"

    ${if} ${FileExists} "$vkOldInstallDir\data\*.*"
      ${if} ${FileExists} "$vkCarryDir\*.*"
        # A carry folder from an earlier interrupted run AND a live data\.
        # There is no telling which is newer or complete, so neither is
        # touched. The update goes the old way, and customInstall tells the
        # user about the leftover carry folder if it gets that far.
        DetailPrint `Leaving data folder in place: "$vkCarryDir" already exists from an earlier update.`
      ${else}
        ClearErrors
        Rename "$vkOldInstallDir\data" "$vkCarryDir"
        ${if} ${Errors}
          # Something inside data\ is open (a stray python.exe, an indexer, an
          # antivirus scan). Carry on exactly as the stock installer would:
          # the old uninstaller gets its chance and reports for itself.
          DetailPrint `Could not move "$vkOldInstallDir\data" aside; updating without carrying it.`
        ${else}
          StrCpy $vkCarried "1"
          DetailPrint `Moved "$vkOldInstallDir\data" aside to "$vkCarryDir" for the update.`
        ${endif}
      ${endif}
    ${endif}
    # No live data\ but a carry folder present: the carry folder is the only
    # copy of the environment, stranded by an interrupted update. It is left
    # exactly where it is and customInstall restores it.
  ${endif}
  Pop $R0
!macroend

# Replaces the SHELL_CONTEXT half of handleUninstallResult (installUtil.nsh):
# electron-builder calls this INSTEAD of its own check and then returns, so
# the stock logic is reproduced - "could not launch the uninstaller" only logs
# and continues; a non-zero exit shows uninstallFailed and quits with
# errorlevel 2. The addition is putting a carried data\ back before that Quit,
# so a failed update leaves the old install whole. /SD IDOK is also added: the
# stock box has no silent default, and NSIS shows a box without /SD even in
# silent mode, so a failed silent update sat on a dialog nobody asked for.
!macro customUnInstallCheck
  ${if} ${Errors}
    DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
  ${elseif} $R0 != 0
    !insertmacro vkRestoreCarryToOldInstall
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

!macro vkRestoreCarryToOldInstall
  ${if} $vkCarried == "1"
  ${andIf} ${FileExists} "$vkOldInstallDir\*.*"
  ${andIfNot} ${FileExists} "$vkOldInstallDir\data\*.*"
    ClearErrors
    Rename "$vkCarryDir" "$vkOldInstallDir\data"
    ${ifNot} ${Errors}
      StrCpy $vkCarried "0"
    ${endif}
    # On failure the carry folder simply stays put; the next installer run
    # finds it in customInstall and nothing is lost.
  ${endif}
!macroend

!macro customInstall
  Push $R0
  # Prefer the carry folder located from this run's registry read. Fall back
  # to the one named after $INSTDIR: that is how a carry stranded by an
  # earlier, interrupted run is found once the old registry keys are gone.
  StrCpy $R0 ""
  ${if} $vkCarryDir != ""
  ${andIf} ${FileExists} "$vkCarryDir\*.*"
    StrCpy $R0 $vkCarryDir
  ${elseIf} ${FileExists} "$INSTDIR.update-data\*.*"
    StrCpy $R0 "$INSTDIR.update-data"
  ${endif}

  ${if} $R0 != ""
    ClearErrors
    ${if} ${FileExists} "$INSTDIR\data\*.*"
      # Both exist: never merge into or overwrite either one.
      SetErrors
    ${else}
      # $INSTDIR is not the old location if the user picked another folder on
      # the directory page. Same volume: this still works. Another drive:
      # Rename refuses (a cross-volume directory move is a copy), and copying
      # GBs of long paths is exactly what NSIS cannot do - so the user is
      # told instead.
      Rename "$R0" "$INSTDIR\data"
    ${endif}

    ${if} ${Errors}
      DetailPrint `Could not restore "$R0" to "$INSTDIR\data".`
      MessageBox MB_OK|MB_ICONEXCLAMATION "${PRODUCT_NAME} kept the Python environment from the previous version in:$\r$\n$\r$\n$R0$\r$\n$\r$\nbut could not move it back into the install folder. To keep it, close ${PRODUCT_NAME}, remove any $\"data$\" folder in:$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nand move the folder above there, renamed to $\"data$\". Otherwise ${PRODUCT_NAME} sets the environment up again on first launch, and the folder above can be deleted." /SD IDOK
    ${else}
      DetailPrint `Restored the Python environment from "$R0".`
    ${endif}
  ${endif}
  Pop $R0
!macroend

# A real uninstall (customRemoveFiles, non-updated branch) deliberately does
# NOT remove a leftover "<install folder>.update-data". It only exists if an
# update was interrupted, it sits outside $INSTDIR, and it may be the only
# copy of the environment; an uninstall that reaches outside its own folder to
# delete several GB the user never saw it create is worse than leaving one
# clearly named folder behind.
