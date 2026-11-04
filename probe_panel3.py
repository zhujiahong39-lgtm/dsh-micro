import sys, os, io

TOOLS = r"C:\Users\20381\project\micro\atk-ai-micro-keyboard\tools"
sys.path.insert(0, TOOLS)
os.chdir(TOOLS)
out = io.open(r"C:\Users\20381\project\dsh-micro\probe_out.txt", "w", encoding="utf-8")

import tkinter as tk
import vid_pid_panel as vp

root = tk.Tk()
app = vp.Panel(root)
counts = {"n": 0}
original = app._append_log


def counting(text):
    if text.startswith("失败"):
        counts["n"] += 1
    original(text)


app._append_log = counting


def dump():
    out.write("failures_after_20s: %d\n" % counts["n"])
    out.write("status: %s\n" % app.status.cget("text"))
    out.write("threads: %d\n" % __import__("threading").active_count())
    out.flush()
    out.close()
    root.destroy()


root.after(20000, dump)
root.mainloop()
