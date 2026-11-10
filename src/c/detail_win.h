#pragma once
#include <pebble.h>

#include "model.h"

// Shows one item (a copy, so list updates don't change it). Select opens the action menu.
void detail_win_push(const Item *item);

// RESULT from the phone: the outcome of Mark watched.
void detail_win_on_result(int state, const char *text);
void detail_win_on_send_failed(uint8_t cmd);
