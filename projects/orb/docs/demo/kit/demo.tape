Output demo.gif
Set Shell "bash"
Set FontFamily "JetBrainsMono Nerd Font"
Set FontSize 16
Set Width 1280
Set Height 720
Set Padding 0
Set Margin 0
Set Framerate 30
Set TypingSpeed 70ms
Set Theme { "name": "tokyonight-moon", "black": "#1b1d2b", "red": "#ff757f", "green": "#c3e88d", "yellow": "#ffc777", "blue": "#82aaff", "magenta": "#c099ff", "cyan": "#86e1fc", "white": "#828bb8", "brightBlack": "#444a73", "brightRed": "#ff757f", "brightGreen": "#c3e88d", "brightYellow": "#ffc777", "brightBlue": "#82aaff", "brightMagenta": "#c099ff", "brightCyan": "#86e1fc", "brightWhite": "#c8d3f5", "background": "#222436", "foreground": "#c8d3f5", "selection": "#2d3f76", "cursor": "#c8d3f5" }

# Markers the keys.py wrapper turns into kitty keys: ⌘x is Alt+x (Cmd+x through
# kitty's Cmd→Alt maps), ⌃H/⌃L are <C-g> h/l, ⌃[/⌃] are Ctrl+[/], and 🖱x,y;
# is a click at column x, row y.

Hide
Type "source launch.sh"
Enter
Sleep 1s
Type "orb"
Enter
Sleep 10s
Show

# --- the sidebar: sessions, their agents and what each one is doing ---
Sleep 2.5s
Screenshot shots/01-start.png

# --- a new colony in the Research world ---
Ctrl+G
Type "c"
Sleep 1.2s
Type "res"
Sleep 600ms
Screenshot shots/02-worlds.png
Enter
Sleep 600ms
Type "auth-providers"
Sleep 500ms
Screenshot shots/03-name.png
Enter
Sleep 1.5s
Type "claude"
Enter
Sleep 1.5s
Type@40ms "Compare Okta, Auth0 and Clerk, one colonist each"
Sleep 400ms
Enter

# --- the chief starts colonists with orb session create ---
Sleep 4s
Screenshot shots/04-chief.png
Type "⌃H"
Sleep 600ms
Type "j"
Sleep 400ms
Type "l"
Sleep 3s
Screenshot shots/05-colonists.png
Sleep 5s
Screenshot shots/06-statuses.png

# --- approve a colonist's tool call ---
Type "/"
Sleep 300ms
Type "clerk"
Sleep 600ms
Enter
Sleep 400ms
Enter
Sleep 1.5s
Screenshot shots/07-approval.png
Type "1"
Sleep 3s
Screenshot shots/08-approved.png

# --- a floating shell over the panes ---
Type "⌘f"
Sleep 1s
Type "ls"
Enter
Sleep 1.5s
Screenshot shots/09-float.png
Type "⌘f"
Sleep 800ms

# --- which-key, then quit: every pane keeps running ---
Ctrl+G
Sleep 2s
Screenshot shots/10-whichkey.png
Type "q"
Sleep 1.5s
Screenshot shots/11-quit.png
Type "orb"
Enter
Sleep 2.5s
Screenshot shots/12-back.png
Type "/"
Sleep 300ms
Type "okta"
Sleep 600ms
Enter
Sleep 400ms
Enter
Sleep 2.5s
Screenshot shots/13-okta.png
Sleep 500ms
