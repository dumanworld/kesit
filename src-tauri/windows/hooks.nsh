; Kaldırırken sağ tık menüsündeki "Kesit ile düzenle" kaydını da sil.
!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$INSTDIR\Kesit.exe" --sag-tik-kaldir'
!macroend
