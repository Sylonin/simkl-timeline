#pragma once
#include <pebble.h>

#include "model.h"

#define UI_ROUND PBL_IF_ROUND_ELSE(true, false)
#define UI_ACCENT PBL_IF_COLOR_ELSE(GColorRed, GColorBlack)
#define UI_BAR_OK PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack)
#define UI_HEADER_BG PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite)

void ui_init(void);

GFont ui_title_font(void);  // bold, list titles and detail heading
GFont ui_body_font(void);
GFont ui_small_font(void);
GFont ui_code_font(void);   // sign-in code
int16_t ui_title_h(void);   // line heights, measured once
int16_t ui_body_h(void);
int16_t ui_small_h(void);
int16_t ui_code_h(void);

// Horizontal text inset for a full-width row or text block.
int16_t ui_pad(void);

// "21:00" or "9:00 PM" following the watch's 12/24 h setting.
void ui_time_string(char *buf, size_t size, time_t t);
// "Yesterday", "Today", "Tomorrow" or "Wed 12 Nov".
void ui_day_label(char *buf, size_t size, time_t t);
// "Wed 12 Nov, 21:00", or just the date for all-day items.
void ui_when_string(char *buf, size_t size, const Item *item);
// Subtitle for lists: "21:00 · S2 E5", or the sub alone for all-day items.
void ui_sub_line(char *buf, size_t size, const Item *item);
// Long finale wording, NULL when the item is not a finale.
const char *ui_finale_text(const Item *item);
// Whole local days between now and t (negative for the past).
int ui_days_from_today(time_t t);
// Same local day?
bool ui_same_day(time_t a, time_t b);

// Draws one wrapped text block; with ctx NULL it only measures. Returns the height used.
int16_t ui_text_block(GContext *ctx, const char *text, GFont font, int16_t x, int16_t y,
                      int16_t w, GTextAlignment align, int16_t max_h);
