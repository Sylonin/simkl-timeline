#include "signin_win.h"

#include <string.h>

#include "comm.h"
#include "ui.h"

#define QUIET_MODULES 2
#define CODE_LEN 16
#define MSG_LEN 100

typedef enum {
  StepWaiting,  // asked for a code
  StepCode,     // code and QR on screen
  StepMessage,  // expired, error or phone away: text plus "try again"
} Step;

static Window *s_window;
static Layer *s_layer;
static Step s_step;
static bool s_active;  // phone has a live code that SIGNIN_STOP should cancel

static char s_code[CODE_LEN];
static time_t s_expires;
static uint8_t s_qr_size;
static uint8_t *s_qr;
static char s_message[MSG_LEN];

static const char *const URL = "simkl.com/pin";

static void prv_free_qr(void) {
  free(s_qr);
  s_qr = NULL;
  s_qr_size = 0;
}

static void prv_start(void) {
  prv_free_qr();
  s_step = StepWaiting;
  s_active = true;
  // On failure the send-failed handler switches to the message step and clears s_active.
  comm_send_signin_start();
}

static void prv_message(const char *text) {
  s_active = false;
  prv_free_qr();
  s_step = StepMessage;
  snprintf(s_message, sizeof(s_message), "%s", text);
  if (s_layer) {
    layer_mark_dirty(s_layer);
  }
}

void signin_win_on_send_failed(uint8_t cmd) {
  if (!s_window || cmd != CmdSigninStart) {
    return;
  }
  prv_message("Phone not connected.");
}

void signin_win_on_code(const char *code, time_t expires, uint8_t qr_size, const uint8_t *qr,
                        uint16_t qr_len) {
  if (!s_window) {
    return;
  }
  prv_free_qr();
  snprintf(s_code, sizeof(s_code), "%s", code);
  s_expires = expires;
  if (qr && qr_size) {
    s_qr = malloc(qr_len);
    if (s_qr) {
      memcpy(s_qr, qr, qr_len);
      s_qr_size = qr_size;
    }
  }
  s_step = StepCode;
  s_active = true;
  layer_mark_dirty(s_layer);
}

void signin_win_on_result(int state, const char *text) {
  if (!s_window) {
    return;
  }
  if (state == 0) {
    s_active = false;
    window_stack_remove(s_window, true);
    return;
  }
  prv_message(text[0] ? text : (state == 1 ? "The code expired." : "Sign-in failed."));
}

// Drawing --------------------------------------------------------------------------------

static int16_t prv_isqrt(int32_t v) {
  int16_t r = 0;
  while ((int32_t)(r + 1) * (r + 1) <= v) {
    r++;
  }
  return r;
}

// Does a horizontally centred band of the given width, spanning y_top..y_bottom, sit inside
// the screen? On round screens that means inside the circle.
static bool prv_band_fits(int16_t y_top, int16_t y_bottom, int16_t width, int16_t w, int16_t h) {
  if (y_top < 0 || y_bottom > h || width > w) {
    return false;
  }
  if (!UI_ROUND) {
    return true;
  }
  const int16_t r = w / 2;
  const int16_t far_top = y_top < r ? r - y_top : y_top - r;
  const int16_t far_bottom = y_bottom < r ? r - y_bottom : y_bottom - r;
  const int16_t dy = far_top > far_bottom ? far_top : far_bottom;
  if (dy >= r) {
    return false;
  }
  return width / 2 <= prv_isqrt((int32_t)r * r - (int32_t)dy * dy) - 1;
}

static int16_t prv_text_w(const char *text, GFont font) {
  return graphics_text_layout_get_content_size(text, font, GRect(0, 0, 400, 100),
                                               GTextOverflowModeTrailingEllipsis,
                                               GTextAlignmentLeft).w;
}

static void prv_draw_centered(GContext *ctx, const char *text, const char *hint, GRect bounds) {
  const int16_t pad = ui_pad() + PBL_IF_ROUND_ELSE(bounds.size.w / 10, 0);
  const int16_t w = bounds.size.w - 2 * pad;
  const int16_t th = ui_text_block(NULL, text, ui_title_font(), pad, 0, w, GTextAlignmentCenter,
                                   bounds.size.h);
  const int16_t hh = hint ? ui_text_block(NULL, hint, ui_small_font(), pad, 0, w,
                                          GTextAlignmentCenter, bounds.size.h)
                          : 0;
  const int16_t gap = hint ? 8 : 0;
  int16_t y = (bounds.size.h - (th + gap + hh)) / 2;
  if (y < 0) {
    y = 0;
  }
  graphics_context_set_text_color(ctx, GColorBlack);
  ui_text_block(ctx, text, ui_title_font(), pad, y, w, GTextAlignmentCenter, bounds.size.h);
  if (hint) {
    ui_text_block(ctx, hint, ui_small_font(), pad, y + th + gap, w, GTextAlignmentCenter,
                  bounds.size.h);
  }
}

static void prv_draw_qr(GContext *ctx, int16_t x, int16_t y, int16_t scale) {
  graphics_context_set_fill_color(ctx, GColorBlack);
  for (int16_t row = 0; row < s_qr_size; row++) {
    int16_t col = 0;
    while (col < s_qr_size) {
      const uint16_t bit = row * s_qr_size + col;
      if (!((s_qr[bit >> 3] >> (7 - (bit & 7))) & 1)) {
        col++;
        continue;
      }
      int16_t end = col + 1;
      while (end < s_qr_size) {
        const uint16_t b = row * s_qr_size + end;
        if (!((s_qr[b >> 3] >> (7 - (b & 7))) & 1)) {
          break;
        }
        end++;
      }
      graphics_fill_rect(ctx, GRect(x + col * scale, y + row * scale, (end - col) * scale, scale),
                         0, GCornerNone);
      col = end;
    }
  }
}

static void prv_draw_code(GContext *ctx, GRect bounds) {
  const int16_t w = bounds.size.w;
  const int16_t h = bounds.size.h;
  const int16_t hc = ui_code_h();
  const int16_t hs = ui_small_h();

  const time_t remaining = s_expires > 0 ? s_expires - time(NULL) : 1;
  char tail[24];
  char countdown[28];
  if (remaining <= 0) {
    snprintf(tail, sizeof(tail), "expired");
    snprintf(countdown, sizeof(countdown), "Code expired");
  } else {
    const int minutes = (int)((remaining + 59) / 60);
    snprintf(tail, sizeof(tail), "%d min left", minutes);
    snprintf(countdown, sizeof(countdown), "Expires in %d min", minutes);
  }
  char combined[48];
  snprintf(combined, sizeof(combined), "%s \xC2\xB7 %s", URL, tail);

  const int16_t wc = prv_text_w(s_code, ui_code_font());
  const int16_t wcombined = prv_text_w(combined, ui_small_font());
  const int16_t wurl = prv_text_w(URL, ui_small_font());
  const int16_t wcount = prv_text_w(countdown, ui_small_font());

  const int16_t modules = s_qr_size ? s_qr_size + 2 * QUIET_MODULES : 0;
  int16_t scale = 0;
  int16_t top = 0;
  bool two_lines = false;

  if (modules == 0) {
    // No QR: the code and address on their own, vertically centred.
    two_lines = true;
    top = (h - (hc + 2 * hs + 6)) / 2;
    if (top < 0) {
      top = 0;
    }
  } else {
    int16_t best_scale = w < h ? w / modules : h / modules;
    bool found = false;
    for (scale = best_scale; scale >= 1 && !found; scale--) {
      const int16_t total = modules * scale;
      for (int variant = 0; variant < 2 && !found; variant++) {
        const int16_t text_h = hc + (variant ? 2 * hs : hs) + 2;
        const int16_t block = total + text_h;
        if (block > h) {
          continue;
        }
        const int16_t mid = (h - block) / 2;
        for (int16_t off = 0; off <= h && !found; off++) {
          for (int sign = 0; sign < 2 && !found; sign++) {
            const int16_t y0 = sign ? mid - off : mid + off;
            if (y0 < 0 || y0 + block > h || (off == 0 && sign == 1)) {
              continue;
            }
            const int16_t yc = y0 + total;
            const bool ok = prv_band_fits(y0, y0 + total, total, w, h) &&
                            prv_band_fits(yc, yc + hc, wc, w, h) &&
                            (variant
                                 ? prv_band_fits(yc + hc, yc + hc + hs, wurl, w, h) &&
                                       prv_band_fits(yc + hc + hs, yc + hc + 2 * hs, wcount, w, h)
                                 : prv_band_fits(yc + hc, yc + hc + hs, wcombined, w, h));
            if (ok) {
              found = true;
              top = y0;
              two_lines = variant == 1;
              best_scale = scale;
            }
          }
        }
      }
      if (found) {
        break;
      }
    }
    scale = found ? best_scale : 1;
    if (!found) {
      top = 0;
      two_lines = false;
    }
  }

  int16_t y = top;
  if (modules) {
    prv_draw_qr(ctx, (w - s_qr_size * scale) / 2, y + QUIET_MODULES * scale, scale);
    y += modules * scale;
  }
  graphics_context_set_text_color(ctx, GColorBlack);
  graphics_draw_text(ctx, s_code, ui_code_font(), GRect(0, y - 2, w, hc + 4),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  y += hc;
  graphics_context_set_text_color(ctx, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
  if (two_lines) {
    graphics_draw_text(ctx, URL, ui_small_font(), GRect(0, y - 2, w, hs + 4),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
    graphics_draw_text(ctx, countdown, ui_small_font(), GRect(0, y + hs - 2, w, hs + 4),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  } else {
    graphics_draw_text(ctx, combined, ui_small_font(), GRect(0, y - 2, w, hs + 4),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }
}

static void prv_update(Layer *layer, GContext *ctx) {
  const GRect bounds = layer_get_bounds(layer);
  switch (s_step) {
    case StepWaiting:
      prv_draw_centered(ctx, "Getting your sign-in code...", NULL, bounds);
      break;
    case StepMessage:
      prv_draw_centered(ctx, s_message, "Press Select to try again", bounds);
      break;
    case StepCode:
      prv_draw_code(ctx, bounds);
      break;
  }
}

// Window ---------------------------------------------------------------------------------

static void prv_select(ClickRecognizerRef recognizer, void *context) {
  if (s_step == StepMessage) {
    prv_start();
    layer_mark_dirty(s_layer);
  }
}

static void prv_click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select);
}

// The countdown is in whole minutes, so a minute tick is all it needs.
static void prv_tick(struct tm *tick_time, TimeUnits units) {
  if (s_step == StepCode) {
    layer_mark_dirty(s_layer);
  }
}

static void prv_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_layer = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_layer, prv_update);
  layer_add_child(root, s_layer);
  tick_timer_service_subscribe(MINUTE_UNIT, prv_tick);
  prv_start();
}

static void prv_unload(Window *window) {
  tick_timer_service_unsubscribe();
  if (s_active) {
    comm_send_signin_stop();
    s_active = false;
  }
  prv_free_qr();
  layer_destroy(s_layer);
  s_layer = NULL;
  window_destroy(s_window);
  s_window = NULL;
}

void signin_win_push(void) {
  if (s_window) {
    return;
  }
  s_window = window_create();
  window_set_background_color(s_window, GColorWhite);
  window_set_click_config_provider(s_window, prv_click_config);
  window_set_window_handlers(s_window, (WindowHandlers){.load = prv_load, .unload = prv_unload});
  window_stack_push(s_window, true);
}
