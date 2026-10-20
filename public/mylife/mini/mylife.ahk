; MyLife — AutoHotkey v2 script (https://www.autohotkey.com, install v2).
; Save this file anywhere, double-click to run. To start it with Windows:
; Win+R → shell:startup → put a shortcut to this file there.
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

CHROME   := "C:\Program Files\Google\Chrome\Application\chrome.exe"
TELEGRAM := EnvGet("APPDATA") "\Telegram Desktop\Telegram.exe"
; Path to your VPN client. Leave "" to skip. Examples:
;   "C:\Program Files\AmneziaVPN\AmneziaVPN.exe"
;   "C:\Program Files\Outline\Outline.exe"
VPN      := ""

; Tabs Chrome opens on Ctrl+Alt+W
TABS := [
    "https://tasktracker.oxion-ezhkov.workers.dev/mylife/",
    "https://mail.google.com/",
    "https://calendar.google.com/",
]

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

^!w:: {
    if (VPN != "" && FileExist(VPN))
        StartOnce(VPN)
    if FileExist(TELEGRAM)
        StartOnce(TELEGRAM)

    args := ""
    for url in TABS
        args .= ' "' url '"'
    Run('"' CHROME '" --new-window' args)

    Sleep(1500)
    if !WinExist(MINI_TITLE)
        OpenMini()
}

; Runs a program unless it's already running (so Telegram/VPN don't double up)
StartOnce(path) {
    SplitPath(path, &exe)
    if !ProcessExist(exe)
        Run('"' path '"')
}
