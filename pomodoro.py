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
        
        startbut = tk.Button(self, text="Start", command=lambda: self.tmr.modeselector("Pomodoro"), width=15)
        stopbut = tk.Button(self, text="Pause", command=lambda: self.tmr.cancel(), width=15) 
        startbut.grid(row=3, columnspan=1, column=0, sticky='w')
        stopbut.grid(row=3, columnspan=1, column=2, sticky='ew')    
        # Need reset button
        
        unprod = tk.Button(self, text="Undprod", command=lambda: self.tmr.modeselector("unproductive"), width=15)
        unprod.grid(row=3, columnspan=1, column=3, sticky='e')    
        
    def dataextract(self):
        pass # We will reset timers after taking the variables.

####################################################################################################

class Timers():
    
    def __init__(self):
        self.mode = None
        
        self.t_d = None
        self.t_u = None
        self.t_p = None
        
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
            
    def modeselector(self, mode = "Pomodoro"):
        self.cancel()
        
        
        # ---Initial click variable setting---
        self.start = int(app.pomostart.get()) # Fetch blocks
        self.stop = int(app.pomostop.get())
        
        #else: 
         #   self.t_d += 1 # Means we are continuing, compensating for delays      
            
        if self.t_u is None: # For counting up
            self.t_u = 0
        if self.t_p is None:
            self.t_p = 0
        
        # ---Mode Selecting---
         
        self.mode = mode
        if mode is "Pomodoro":
            if self.brake is True: # Break check
                print("Here")
                self.mode = "Break"
                self.countdown(self.stop)
                
            else:
                if self.t_d is None: # For counting down
                    self.countdown(self.start)
                else: self.countdown(self.t_d)
            
        elif mode is "unproductive":
            self.countup()
            
        elif mode is "productive":
            self.countup()
    

    
    def countdown(self, t = None):
        '''Counts down from a start number, optionality for modes'''
        if t is not None: # As long as num is not none
            self.t_d = t
            
        if self.t_d >= 1: # > 0
            mins, secs = divmod(t, 60) #returns tuple num & denom
            timeformat = '{:02d}:{:02d}'.format(mins, secs) #02d formats an integer (d) to a field of minimum width 2 (2), with zero-padding on the left (leading 0):
            self.changeTime(timeformat) #carriage to replcae
            t -= 1
            self._job = app.after(1000, self.countdown, t)  

        # When timer reaches 0

            # If Pomodoro Mode
        elif self.mode == "Pomodoro":
                self.brake = True # Sets to break mode
                
                #self.mode = "Break"
                self.changeTime("Moving to break") #Update text
                app.update()
                time.sleep(1)
                self.modeselector()
                #
                #self.countdown(self.stop) # Starts again from break num (gotta change that name)
                return

        elif self.mode == "Break": # If reaches 0 on break mode
                self.changeTime("Break Over") # Resets everything for new iteration
                self.brake = False    ######### JUST ADD RESET FUNCTION
                
                self.t_d = None
                self.mode = None
                return
        
    def countup(self):
        '''Counts up from a 0'''
        def counter(t):
            mins, secs = divmod(t, 60) #returns tuple num & denom
            timeformat = '{:02d}:{:02d}'.format(mins, secs) #02d formats an integer (d) to a field of minimum width 2 (2), with zero-padding on the left (leading 0):
            self.changeTime(timeformat) #carriage to replcae
            t += 1
            self._job = app.after(1000, self.countup)
            return t

        
        if self.mode is "unproductive":
            self.t_u = counter(self.t_u)    
        elif self.mode is "productive":
            self.t_p = counter(self.t_p)
    

    def changeTime(self, i):
        '''Text updater'''
        app.text.set(self.mode)
        app.time.set(i)   
        # break check here to clean it?

#ExampleApp()
if __name__ == "__main__":
    app = PomoApp()
    app.mainloop()
    
