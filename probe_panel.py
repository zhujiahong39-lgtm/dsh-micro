import sys, os
TOOLS = r"C:\Users\20381\project\micro\atk-ai-micro-keyboard\tools"
sys.path.insert(0, TOOLS)
os.chdir(TOOLS)

import tkinter as tk
import vid_pid_panel as vp

root = tk.Tk()
app = vp.Panel(root)

def dump():
    try:
        print("STATUS:", app.status.cget("text"))
        print("LOG:")
        print(app.log_text.get("1.0", "end").strip())
        print("ROWS:", len(app.devices), [ (d["path"][:40], hex(d["vid"]), hex(d["pid"]), d["mode"]) for d in app.devices])
    finally:
        root.destroy()

root.after(5000, dump)
root.mainloop()
