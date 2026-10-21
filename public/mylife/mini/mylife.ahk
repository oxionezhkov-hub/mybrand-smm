; MyLife — AutoHotkey v2 script (https://www.autohotkey.com, install v2).
; Save this file anywhere and double-click it once: it adds itself to Windows
; startup, so after a reboot the hotkeys work and the workday opens by itself.
;
;   Ctrl+Alt+M     — show / hide the small MyLife window (always on top)
;   Ctrl+Space     — pin / unpin whatever window is active (always on top)
;   Ctrl+Alt+W     — start the workday: Telegram, VPN, Chrome with tabs
#Requires AutoHotkey v2.0
#SingleInstance Force

; ── Settings — edit to taste ─────────────────────────────────────────────────

MINI_URL    := "https://tasktracker.oxion-ezhkov.workers.dev/mylife/mini/"
MINI_TITLE  := "MyLife mini"            ; page <title>, used to find the window
MINI_W      := 340
MINI_H      := 520
MINI_MARGIN := 16                        ; gap from the screen's bottom-right corner

; Full path to the .exe file itself, not to its folder.
CHROME   := "C:\Program Files\Google\Chrome\Application\chrome.exe"
TELEGRAM := EnvGet("APPDATA") "\Telegram Desktop\Telegram.exe"
; Path to your VPN client. Leave "" to skip. Examples:
;   "C:\Program Files\AmneziaVPN\AmneziaVPN.exe"
;   "C:\Program Files\Outline\Outline.exe"
VPN      := ""

; Open Telegram, VPN, Chrome and MyLife automatically when Windows starts
AUTO_START_WORKDAY := true
; How long to wait after boot before opening them (network, VPN, etc.), seconds
BOOT_DELAY := 20

; Tabs Chrome opens on Ctrl+Alt+W
TABS := [
    "https://tasktracker.oxion-ezhkov.workers.dev/mylife/",
    "https://mail.google.com/",
    "https://calendar.google.com/",
]

; ── Startup ──────────────────────────────────────────────────────────────────

; Keep a shortcut to this script in the Startup folder. Re-created on every run,
; so it stays correct even if the script file is moved.
; The shortcut passes /autostart, which tells a boot launch from a double-click.
FileCreateShortcut(A_ScriptFullPath, A_Startup "\MyLife.lnk", A_ScriptDir, "/autostart")

if (AUTO_START_WORKDAY && A_Args.Length && A_Args[1] = "/autostart")
    SetTimer(StartWorkday, -BOOT_DELAY * 1000)

; ── Ctrl+Alt+M: MyLife mini window ───────────────────────────────────────────

^!m:: {
    if WinExist(MINI_TITLE) {
        if WinActive(MINI_TITLE) {
            WinMinimize(MINI_TITLE)
        } else {
            WinRestore(MINI_TITLE)
            WinActivate(MINI_TITLE)
        }
        return
    }
    OpenMini()
}

OpenMini() {
    ; --app opens the page as a standalone window without tabs or address bar
    Run('"' CHROME '" --app=' MINI_URL ' --window-size=' MINI_W ',' MINI_H)
    if !WinWait(MINI_TITLE, , 15)
        return
    MonitorGetWorkArea(MonitorGetPrimary(), &L, &T, &R, &B)
    WinMove(R - MINI_W - MINI_MARGIN, B - MINI_H - MINI_MARGIN, MINI_W, MINI_H, MINI_TITLE)
    WinSetAlwaysOnTop(1, MINI_TITLE)
}

; ── Ctrl+Space: pin any window on top ────────────────────────────────────────

^Space:: {
    WinSetAlwaysOnTop(-1, "A")
    ToolTip((WinGetExStyle("A") & 0x8) ? "📌 Поверх всех окон" : "Откреплено")
    SetTimer(() => ToolTip(), -1000)
}

; ── Ctrl+Alt+W: start the workday ────────────────────────────────────────────

^!w:: StartWorkday()

StartWorkday(*) {
    if (VPN != "")
        Launch(VPN)
    ; Telegram keeps a single instance: launching it again just brings the
    ; window back from the tray, so it is always run.
    Launch(TELEGRAM)

    args := ""
    for url in TABS
        args .= ' "' url '"'
    Run('"' CHROME '" --new-window' args)

    Sleep(1500)
    if !WinExist(MINI_TITLE)
        OpenMini()
}

; Runs a program; says so instead of failing silently when the path is wrong
Launch(path) {
    if !FileExist(path) || InStr(FileExist(path), "D") {
        MsgBox("Не найден файл:`n" path "`n`nУкажи полный путь к .exe в настройках скрипта.", "MyLife", "Icon!")
        return
    }
    SplitPath(path, , &dir)
    Run('"' path '"', dir)
}
