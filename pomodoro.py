# Save variables to file
# Minute second switch, 
# Unproductive mode, X
# Productive mode,
    # Export that data
#Styliziing
#Pause instead of exit
    #  if pause stops clock, saves number, reuses it if unpause button
# setting new time asks if u wanna save the data or not


import tkinter as tk
#from tkinter import *
from tkinter import ttk
import time


class PomoApp(tk.Tk):
    def __init__(self):
        tk.Tk.__init__(self) # This class is itself a tk class
        self.tmr = Timers()
        self.window()
        
        
    def window(self):
        '''Creates window with placements'''
        
        
        self.text = tk.StringVar()
        #self.text.set = "Pomodomo"
        self.title = tk.Label(self, textvariable=self.text, font = ('Arial', 25, 'bold'))
        self.title.grid(row=0, column=0, columnspan=4)
        
        self.time = tk.StringVar()
        self.label = tk.Label(self, textvariable=self.time, font = ('Arial', 25, 'bold'))
        
        self.columnconfigure(3, weight=1)
        self.label.grid(row=1, column=0, columnspan=4)
        
        block_label = tk.Label(self, text = "Block:").grid(row=2,column=0, sticky='w')
        brake_label = tk.Label(self, text = "Break:").grid(row=2,column=2, sticky='e')
        
        
        self.pomostart = tk.Entry(self)
        self.pomostart.grid(row=2,column=1, sticky='w')
        
        self.pomostop = tk.Entry(self)
        self.pomostop.grid(row=2,column=3, sticky='e')
        
        startbut = tk.Button(self, text="Start", command=lambda: self.tmr.pomodoro(), width=15)
        stopbut = tk.Button(self, text="Pause", command=lambda: self.tmr.cancel(), width=15) 
        startbut.grid(row=3, columnspan=1, column=0, sticky='w')
        stopbut.grid(row=3, columnspan=1, column=2, sticky='ew')    
        
        unprod = tk.Button(self, text="Undprod", command=lambda: self.tmr.unproductive(), width=15)
        unprod.grid(row=3, columnspan=1, column=3, sticky='e')    
        
    def dataextract(self):
        pass # We will reset timers after taking the variables.

####################################################################################################

class Timers():
    
    def __init__(self):
        self.mode = None
        
        self.t_d = None
        self.t_u = None
        
        self._job = None
        self.brake = False
        print("Loaded Timers...")

    def dataextract(self):
        pass
    
    
    def cancel(self):
        '''Cancels any current after jobs, useful for new iter'''
        
        if self._job is not None:
            app.after_cancel(self._job)
            self._job = None
    
    def pause(self): # and play?
        pass
            
    
    def countdown(self, t = None):
        '''Counts down from a start number, optionality for modes'''
        if t is not None: # As long as num is not none
            self.t_d = t
            
        if self.t_d >= 1: # > 0
            mins, secs = divmod(self.t_d, 60) #returns tuple num & denom
            timeformat = '{:02d}:{:02d}'.format(mins, secs) #02d formats an integer (d) to a field of minimum width 2 (2), with zero-padding on the left (leading 0):
            self.changeTime(timeformat) #carriage to replcae
            self.t_d -= 1
            self._job = app.after(1000, self.countdown)  
        
        # When timer reaches 0
        else:
            if self.mode is None:
                return

            # If Pomodoro Mode
            elif self.mode == "Pomodoro":
                    self.brake = True # Sets to break mode
                    self.mode = "Break"
                    self.changeTime("Moving to break") #Update text
                    app.update()
                    time.sleep(1)
                    self.countdown(self.stop) # Starts again from break num (gotta change that name)
                    return
                
            elif self.mode == "Break": # If reaches 0 on break mode
                    self.changeTime("Break Over") # Resets everything for new iteration
                    self.mode = None
                    self.brake = False    ######### JUST ADD RESET FUNCTION
                    self.t_d = None
                    #self.t_d = None
                    #else:
                     #   self.changeTime("Break Over")
                     # 3  self.t_d = None
        
        
                
    def countup(self):
        '''Counts up from a 0'''
        mins, secs = divmod(self.t_u, 60) #returns tuple num & denom
        timeformat = '{:02d}:{:02d}'.format(mins, secs) #02d formats an integer (d) to a field of minimum width 2 (2), with zero-padding on the left (leading 0):
        self.changeTime(timeformat) #carriage to replcae
        self.t_u += 1
        self._job = app.after(1000, self.countup)

    
    def pomodoro(self):
        '''Pomodoro mode'''
        self.cancel() # Makes sure no ongoing jobs
        
        if self.brake is False: # Not in break mode (could be unproductive)
            self.mode = "Pomodoro" # Set to pomo
            print("Changed")
        else:
            self.mode = "Break" # If it is still in break mode and timer never reached 0, set back
            
        if self.t_d is None: # If no numbers counting down
            self.start = int(app.pomostart.get()) # Fetch blocks
            self.stop = int(app.pomostop.get())
            self.brake = False # Ensure brake is off (Neccesary??)
            self.countdown(self.start) 
        else: # Still numbers left in queue means continuing from another mode, so add 1 (cause the wait is 1)
            self.countdown(self.t_d+1)
            print(self.mode)
        #Start:
        #self.countdown(self.start)

    def unproductive(self):
        '''Unproductive / Sidetracked mode'''
        self.cancel()
        self.mode = "Unproductive / Sidetracked"
        
        if self.t_u is None:
            self.t_u = 0 
        self.countup()
    
    def changeTime(self, i):
        '''Text updater'''
        app.text.set(self.mode)
        app.time.set(i)   
        # break check here to clean it?

#ExampleApp()
if __name__ == "__main__":
    app = PomoApp()
    app.mainloop()
    
