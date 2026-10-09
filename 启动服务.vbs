Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "D:\taobao-activity-monitor"
' Start admin backend (stdout appends to logs\admin-server.log)
WshShell.Run "cmd /c node admin-server.js >> logs\admin-server.log 2>&1", 0, False
WScript.Sleep 2000
' Start monitor (writes its own full log to logs\monitor.log, no stdout redirect)
WshShell.Run "cmd /c node monitor.js", 0, False
