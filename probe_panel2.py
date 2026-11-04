import sys, os, io

TOOLS = r"C:\Users\20381\project\micro\atk-ai-micro-keyboard\tools"
sys.path.insert(0, TOOLS)
os.chdir(TOOLS)
out = io.open(r"C:\Users\20381\project\dsh-micro\probe_out.txt", "w", encoding="utf-8")

out.write("PYTHON: %s %s\n" % (sys.version, sys.executable))
try:
    import hid
    out.write("HID: %s\n" % getattr(hid, "__version__", "imported"))
except Exception as exc:
    out.write("HID IMPORT ERROR: %r\n" % (exc,))

import tkinter as tk
import vid_pid_panel as vp

root = tk.Tk()
app = vp.Panel(root)


def dump():
    try:
        out.write("STATUS: %s\n" % app.status.cget("text"))
        out.write("LOG:\n%s\n" % app.log_text.get("1.0", "end").strip())
        out.write("ROWS: %d\n" % len(app.devices))
        for d in app.devices:
            out.write("  %r %04X:%04X %s %r\n" % (d["path"][:50], d["vid"], d["pid"], d["mode"], d["release"]))
    except Exception:
        import traceback
        out.write("DUMP ERROR:\n" + traceback.format_exc())
    finally:
        out.flush()
        out.close()
        root.destroy()


root.after(5000, dump)
root.mainloop()
