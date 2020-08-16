import tkinter as tk
import time


class Clocker(tk.Tk):
    def __init__(self):
        tk.Tk.__init__(self)
        self.text = tk.StringVar()
        self.label = tk.Label(self, textvariable=self.text)
        self.mode = None
        
        self.pomodoro(5, 4)
        
        self.label.pack()
        self.mainloop()
        
    

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
                
        
    def pomodoro(self, start, stop):
        self.mode = "pomodoro"
        self.start = int(start)
        self.stop = int(stop)
        self.brake = False
        
        #Start:
        self.countdown(self.start)
            
    def changeText(self, i):
        self.text.set(i)   
    
    
#ExampleApp()
if __name__ == "__main__":
     app = Clocker()
     app.mainloop()
