# Save variables to file
# Minute second switch, 
# Unproductive mode, Productive mode,
    # Export that data
#Styliziing
#Pause instead of exit
    #  if pause stops clock, saves number, reuses it if unpause button


import tkinter as tk
#from tkinter import *
from tkinter import ttk
import time


class Clocker(tk.Tk):
    def __init__(self):
        tk.Tk.__init__(self)
        self.window()
        
        self.mode = None
        
        
    def window(self):
        self.text = tk.StringVar()
        self.label = tk.Label(self, textvariable=self.text)
        
        self.columnconfigure(3, weight=1)
        self.label.grid(row=0, column=0, columnspan=4)
        
        block_label = tk.Label(self, text = "Block:").grid(row=1,column=0, sticky='w')
        brake_label = tk.Label(self, text = "Break:").grid(row=1,column=2, sticky='e')
        
        self.pomostart = tk.Entry(self)
        self.pomostart.grid(row=1,column=1, sticky='w')
        
        self.pomostop = tk.Entry(self)
        self.pomostop.grid(row=1,column=3, sticky='e')
        
        startbut = tk.Button(self, text="Start", command= lambda: self.pomodoro(), width=15)
        stopbut = tk.Button(self, text="Stop", command=self.destroy, width=15) 
        startbut.grid(row=2, columnspan=2, column=0, sticky='ew')
        stopbut.grid(row=2, columnspan=2, column=2, sticky='ew')    
        

    def countdown(self, t = None):
        if t is not None:
            self.t = t
            
        if self.t <= 0:
            # No Mode
            if self.mode is None:
                return

            # Pomodoro Mode
            elif self.mode == "pomodoro":
                    if self.brake is False:
                        self.brake = True
                        self.changeText("Moving to break")
                        self.update()
                        time.sleep(1)
                        self.countdown(self.stop)
                        return
                    else:
                        self.changeText("Break Over")
        
        else:
            mins, secs = divmod(self.t, 60) #returns tuple num & denom
            timeformat = '{:02d}:{:02d}'.format(mins, secs) #02d formats an integer (d) to a field of minimum width 2 (2), with zero-padding on the left (leading 0):
            self.changeText(timeformat) #carriage to replcae
            self.t -= 1
            self.after(1000, self.countdown)  
                
        
    def pomodoro(self):
        self.mode = "pomodoro"
        self.start = int(self.pomostart.get())
        self.stop = int(self.pomostop.get())
        self.brake = False
        
        #Start:
        self.countdown(self.start)
            
    def changeText(self, i):
        self.text.set(i)   
    
#ExampleApp()
if __name__ == "__main__":
    app = Clocker()
    app.mainloop()
