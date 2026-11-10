#pragma once
#include <pebble.h>

// A plain full-screen message: centred text, optional hint line below it.
// Used for the Mark watched outcome and for the wakeup sync screen.
typedef void (*MsgWinSelect)(void);

// Replaces any message window already open.
void msg_win_push(const char *text, const char *hint, MsgWinSelect on_select);
void msg_win_set_text(const char *text, const char *hint);
// Closes the window after the delay (0 = now). Does nothing when it is not open.
void msg_win_close_after(uint32_t ms);
bool msg_win_is_open(void);
Window *msg_win_window(void);
