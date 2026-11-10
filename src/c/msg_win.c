#include "msg_win.h"

#include <string.h>

#include "ui.h"

#define TEXT_MAX 120
#define HINT_MAX 40

static Window *s_window;
static Layer *s_layer;
static AppTimer *s_close_timer;
static MsgWinSelect s_on_select;
static char s_text[TEXT_MAX];
static char s_hint[HINT_MAX];

static void prv_copy(char *dst, size_t size, const char *src) {
  strncpy(dst, src ? src : "", size - 1);
  dst[size - 1] = '\0';
}

static void prv_update(Layer *layer, GContext *ctx) {
  const GRect bounds = layer_get_bounds(layer);
  const int16_t pad = ui_pad() + PBL_IF_ROUND_ELSE(bounds.size.w / 10, 0);
  const int16_t w = bounds.size.w - 2 * pad;
  const GTextAlignment align = GTextAlignmentCenter;
  const int16_t th = ui_text_block(NULL, s_text, ui_title_font(), pad, 0, w, align, bounds.size.h);
  const int16_t hh = s_hint[0]
      ? ui_text_block(NULL, s_hint, ui_small_font(), pad, 0, w, align, bounds.size.h)
      : 0;
  const int16_t gap = hh ? 8 : 0;
  int16_t y = (bounds.size.h - (th + gap + hh)) / 2;
  if (y < 0) {
    y = 0;
  }
  graphics_context_set_text_color(ctx, GColorBlack);
  ui_text_block(ctx, s_text, ui_title_font(), pad, y, w, align, bounds.size.h);
  if (hh) {
    graphics_context_set_text_color(ctx, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
    ui_text_block(ctx, s_hint, ui_small_font(), pad, y + th + gap, w, align, bounds.size.h);
  }
}

static void prv_select(ClickRecognizerRef recognizer, void *context) {
  if (s_on_select) {
    s_on_select();
  }
}

static void prv_click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select);
}

static void prv_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_layer = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_layer, prv_update);
  layer_add_child(root, s_layer);
}

static void prv_unload(Window *window) {
  layer_destroy(s_layer);
  s_layer = NULL;
  if (s_close_timer) {
    app_timer_cancel(s_close_timer);
    s_close_timer = NULL;
  }
  window_destroy(s_window);
  s_window = NULL;
  s_on_select = NULL;
}

void msg_win_push(const char *text, const char *hint, MsgWinSelect on_select) {
  if (s_window) {
    window_stack_remove(s_window, false);
  }
  prv_copy(s_text, sizeof(s_text), text);
  prv_copy(s_hint, sizeof(s_hint), hint);
  s_on_select = on_select;
  s_window = window_create();
  window_set_background_color(s_window, GColorWhite);
  window_set_click_config_provider(s_window, prv_click_config);
  window_set_window_handlers(s_window, (WindowHandlers){.load = prv_load, .unload = prv_unload});
  window_stack_push(s_window, true);
}

void msg_win_set_text(const char *text, const char *hint) {
  prv_copy(s_text, sizeof(s_text), text);
  prv_copy(s_hint, sizeof(s_hint), hint);
  if (s_layer) {
    layer_mark_dirty(s_layer);
  }
}

static void prv_close_cb(void *data) {
  s_close_timer = NULL;
  if (s_window) {
    window_stack_remove(s_window, true);
  }
}

void msg_win_close_after(uint32_t ms) {
  if (!s_window) {
    return;
  }
  if (ms == 0) {
    window_stack_remove(s_window, true);
    return;
  }
  if (s_close_timer) {
    app_timer_cancel(s_close_timer);
  }
  s_close_timer = app_timer_register(ms, prv_close_cb, NULL);
}

bool msg_win_is_open(void) {
  return s_window != NULL;
}

Window *msg_win_window(void) {
  return s_window;
}
