# Vapourkit NSIS customizations — preserve the app's data folder across updates.
#
# The app stores everything (embedded Python env, models, built engines, user
# config) in $INSTDIR\data. electron-builder's default update flow runs the
# previous version's uninstaller, which wipes the entire install directory —
# destroying multi-GB of user state on every upgrade.
#
# Renames go to a sibling path ("$INSTDIR.vapourkit-data") so they stay on the
# same volume and are instant/atomic, never a copy.

!ifndef VAPOURKIT_CUSTOM_NSH
!define VAPOURKIT_CUSTOM_NSH

!ifndef BUILD_UNINSTALLER
  Var vapourkitDataBackup
!endif

# --- Uninstaller side (ships with 0.17.0+) ---
# During an update: keep data\. During a real uninstall: remove everything,
# matching the previous behavior.
!macro customRemoveFiles
  ${if} ${isUpdated}
    ClearErrors
    Rename "$INSTDIR\data" "$INSTDIR.vapourkit-data"
    SetOutPath $TEMP
    RMDir /r $INSTDIR
    CreateDirectory "$INSTDIR"
    ClearErrors
    Rename "$INSTDIR.vapourkit-data" "$INSTDIR\data"
  ${else}
    SetOutPath $TEMP
    RMDir /r $INSTDIR
  ${endif}
!macroend

# --- Installer side ---
# Uninstallers shipped with 0.16.x and older don't have the macro above and
# destroy data\ during the upgrade. Move it out of harm's way before the old
# uninstaller runs (customInit fires in .onInit, ahead of the install section),
# and restore it once the new files are in place.
!macro customInit
  StrCpy $vapourkitDataBackup ""
  ${if} ${FileExists} "$INSTDIR\data\*"
    ClearErrors
    Rename "$INSTDIR\data" "$INSTDIR.vapourkit-data"
    ${ifNot} ${Errors}
      StrCpy $vapourkitDataBackup "$INSTDIR.vapourkit-data"
    ${endIf}
  ${endIf}
!macroend

!macro customInstall
  ${if} $vapourkitDataBackup != ""
  ${andIf} ${FileExists} "$vapourkitDataBackup\*"
    ${ifNot} ${FileExists} "$INSTDIR\data\*"
      ClearErrors
      Rename "$vapourkitDataBackup" "$INSTDIR\data"
    ${endIf}
  ${endIf}
!macroend

!endif # VAPOURKIT_CUSTOM_NSH
