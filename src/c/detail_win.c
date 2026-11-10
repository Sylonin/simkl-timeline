#include "detail_win.h"

#include <string.h>

#include "comm.h"
#include "msg_win.h"
#include "ui.h"

#define DONE_SHOW_MS 1200
#define TEXT_MAX 120

typedef enum {
  PhaseIdle,
  PhaseWaiting,  // MARK_WATCHED sent, no RESULT yet
  PhaseDone,     // RESULT arrived (s_result_ok / s_result_text)
  PhaseFailed,   // the phone could not be reached
} Phase;

static Window *s_window;
static ScrollLayer *s_scroll;
static Layer *s_content;
static Item s_item;

static Phase s_phase;
static bool s_menu_open;
static bool s_result_ok;
static char s_result_text[TEXT_MAX];
static AppTimer *s_finish_timer;

// Content metrics. Round screens inset the text so it clears the curve of the bezel.
static int16_t prv_side(int16_t w) {
  return ui_pad() + PBL_IF_ROUND_ELSE(w / 16, 0);
}

static int16_t prv_vpad(int16_t w) {
  return PBL_IF_ROUND_ELSE(w * 15 / 100, 4);
}

// One pass draws (ctx != NULL) or measures (ctx == NULL); returns the total content height.
static int16_t prv_layout(GContext *ctx, int16_t w) {
  const int16_t side = prv_side(w);
  const int16_t tw = w - 2 * side;
  const GTextAlignment align = PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft);
  const int16_t gap = 4;
  int16_t y = prv_vpad(w);

  if (ctx) {
    graphics_context_set_text_color(ctx, GColorBlack);
  }
  y += ui_text_block(ctx, s_item.title, ui_title_font(), side, y, tw, align, 400) + gap;

  if (s_item.sub[0]) {
    y += ui_text_block(ctx, s_item.sub, ui_body_font(), side, y, tw, align, 200) + gap;
  }

  const char *finale = ui_finale_text(&s_item);
  if (finale) {
    const GSize text = graphics_text_layout_get_content_size(
        finale, ui_small_font(), GRect(0, 0, tw - 12, 100), GTextOverflowModeTrailingEllipsis,
        GTextAlignmentCenter);
    const int16_t bw = text.w + 12;
    const int16_t bh = ui_small_h() + 2;
    if (ctx) {
      const int16_t bx = align == GTextAlignmentCenter ? side + (tw - bw) / 2 : side;
      graphics_context_set_fill_color(ctx, UI_ACCENT);
      graphics_fill_rect(ctx, GRect(bx, y, bw, bh), 4, GCornersAll);
      graphics_context_set_text_color(ctx, GColorWhite);
      graphics_draw_text(ctx, finale, ui_small_font(), GRect(bx, y - 1, bw, bh),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
      graphics_context_set_text_color(ctx, GColorBlack);
    }
    y += bh + gap + 2;
  }

  char when[40];
  ui_when_string(when, sizeof(when), &s_item);
  y += ui_text_block(ctx, when, ui_body_font(), side, y, tw, align, 200) + gap;

  if (s_item.detail[0]) {
    y += ui_text_block(ctx, s_item.detail, ui_body_font(), side, y, tw, align, 300) + gap;
  }

  char facts[48];
  facts[0] = '\0';
  if (s_item.network[0]) {
    snprintf(facts, sizeof(facts), "%s", s_item.network);
  }
  if (s_item.runtime > 0) {
    const size_t len = strlen(facts);
    snprintf(facts + len, sizeof(facts) - len, "%s%d min", len ? " \xC2\xB7 " : "",
             (int)s_item.runtime);
  }
  if (facts[0]) {
    y += ui_text_block(ctx, facts, ui_small_font(), side, y, tw, align, 100) + gap;
  }

  if (ctx) {
    graphics_context_set_text_color(ctx, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
  }
  y += ui_text_block(ctx, "Select for actions", ui_small_font(), side, y + 4, tw, align, 100) + 4;
  return y + prv_vpad(w);
}

static void prv_content_update(Layer *layer, GContext *ctx) {
  prv_layout(ctx, layer_get_bounds(layer).size.w);
}

// Result window handling -----------------------------------------------------------------

static void prv_finish(void *data) {
  s_finish_timer = NULL;
  msg_win_close_after(0);
  if (s_window) {
    window_stack_remove(s_window, true);
  }
}

static void prv_present(void) {
  if (s_menu_open || s_phase == PhaseIdle) {
    return;
  }
  const char *text = "";
  const char *hint = NULL;
  switch (s_phase) {
    case PhaseWaiting:
      text = "Marking watched...";
      break;
    case PhaseFailed:
      text = "Could not reach the phone.";
      hint = "Press Back";
      break;
    case PhaseDone:
      text = s_result_text;
      hint = s_result_ok ? NULL : "Press Back";
      break;
    default:
      break;
  }
  if (msg_win_is_open()) {
    msg_win_set_text(text, hint);
  } else {
    msg_win_push(text, hint, NULL);
  }
  if (s_phase == PhaseDone && s_result_ok && !s_finish_timer) {
    s_finish_timer = app_timer_register(DONE_SHOW_MS, prv_finish, NULL);
  }
}

void detail_win_on_result(int state, const char *text) {
  if (s_phase != PhaseWaiting) {
    return;
  }
  s_result_ok = state == 0;
  snprintf(s_result_text, sizeof(s_result_text), "%s",
           text[0] ? text : (s_result_ok ? "Marked watched" : "Could not mark it watched."));
  s_phase = PhaseDone;
  prv_present();
}

void detail_win_on_send_failed(uint8_t cmd) {
  if (cmd != CmdMarkWatched || s_phase != PhaseWaiting) {
    return;
  }
  s_phase = PhaseFailed;
  prv_present();
}

// Action menu ----------------------------------------------------------------------------

static void prv_mark_watched(ActionMenu *menu, const ActionMenuItem *action, void *context) {
  s_phase = PhaseWaiting;
  comm_send_mark_watched(&s_item);
}

static void prv_menu_closed(ActionMenu *menu, const ActionMenuItem *performed, void *context) {
  action_menu_hierarchy_destroy(action_menu_get_root_level(menu), NULL, NULL);
  s_menu_open = false;
  if (!performed) {
    s_phase = PhaseIdle;
    return;
  }
  prv_present();
}

static void prv_open_actions(ClickRecognizerRef recognizer, void *context) {
  if (s_menu_open || (s_phase == PhaseWaiting && msg_win_is_open())) {
    return;
  }
  ActionMenuLevel *root = action_menu_level_create(1);
  action_menu_level_add_action(root, "Mark watched", prv_mark_watched, NULL);
  ActionMenuConfig config = {
      .root_level = root,
      .colors = {.background = UI_ACCENT, .foreground = GColorWhite},
      .did_close = prv_menu_closed,
      .align = ActionMenuAlignCenter,
  };
  s_phase = PhaseIdle;
  s_menu_open = true;
  action_menu_open(&config);
}

static void prv_scroll_clicks(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_open_actions);
}

// Window ---------------------------------------------------------------------------------

static void prv_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  const GRect bounds = layer_get_bounds(root);

  s_scroll = scroll_layer_create(bounds);
  scroll_layer_set_callbacks(s_scroll, (ScrollLayerCallbacks){.click_config_provider = prv_scroll_clicks});
  scroll_layer_set_click_config_onto_window(s_scroll, window);
  scroll_layer_set_shadow_hidden(s_scroll, true);

  const int16_t h = prv_layout(NULL, bounds.size.w);
  s_content = layer_create(GRect(0, 0, bounds.size.w, h));
  layer_set_update_proc(s_content, prv_content_update);
  scroll_layer_add_child(s_scroll, s_content);
  scroll_layer_set_content_size(s_scroll, GSize(bounds.size.w, h));
  layer_add_child(root, scroll_layer_get_layer(s_scroll));
}

static void prv_unload(Window *window) {
  if (s_finish_timer) {
    app_timer_cancel(s_finish_timer);
    s_finish_timer = NULL;
  }
  s_phase = PhaseIdle;
  layer_destroy(s_content);
  scroll_layer_destroy(s_scroll);
  s_content = NULL;
  s_scroll = NULL;
  window_destroy(s_window);
  s_window = NULL;
}

void detail_win_push(const Item *item) {
  if (s_window) {
    return;
  }
  s_item = *item;
  s_phase = PhaseIdle;
  s_menu_open = false;
  s_window = window_create();
  window_set_background_color(s_window, GColorWhite);
  window_set_window_handlers(s_window, (WindowHandlers){.load = prv_load, .unload = prv_unload});
  window_stack_push(s_window, true);
}
