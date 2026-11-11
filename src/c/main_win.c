#include "main_win.h"

#include <string.h>

#include "comm.h"
#include "detail_win.h"
#include "model.h"
#include "signin_win.h"
#include "ui.h"

// Layout: a status bar on top and one MenuLayer below it (over it on round screens, so the
// focused row stays centred). Sections, in order:
//   [message or sign-in row] [one section per day with its items] [Sync now row]
// The message row carries the phone's STATUS Text for states 3-6, the "phone away" notes and
// the empty-list message. Select on it, or on Sync now, asks the phone for a manual sync.
// Holding Select on any row does the same: a quick way to refresh without scrolling to the
// last row.
//
// The signed-out state replaces everything with one sign-in row.

#define MAX_SECTIONS (MAX_ITEMS + 2)

typedef enum {
  SecMessage,
  SecSignin,
  SecDay,
  SecAction,
} SecType;

typedef struct {
  uint8_t type;
  uint8_t first;  // index of the first item (SecDay)
  uint8_t count;  // rows in the section
  int32_t day_time;
} Section;

typedef struct {
  bool valid;
  uint8_t type;
  int32_t simkl;
  int16_t season;
  int16_t episode;
} SelectionKey;

static Window *s_window;
static MenuLayer *s_menu;
static Layer *s_bar;
static Section s_sec[MAX_SECTIONS];
static uint8_t s_nsec;
static SelectionKey s_sel;
static int16_t s_menu_w;
static int16_t s_bar_h;

// Text ------------------------------------------------------------------------------------

static const char *prv_message_text(void) {
  if (model_note() == NoteNoPhone) {
    return "The phone is not connected. Check Bluetooth, then press Select to try again.";
  }
  if (model_note() == NoteNoAnswer) {
    return "The phone did not answer. Open the Pebble app, then press Select to try again.";
  }
  const SyncState state = model_state();
  const char *phone = model_text();
  switch (state) {
    case StateNeedsPlugins:
      return phone[0] ? phone
                      : "Turn on plugins in the Pebble app (Settings > Plugins). Version 1.18 or later is needed.";
    case StatePermission:
      return phone[0] ? phone : "Simkl Timeline needs permission. Allow it in the Pebble app.";
    case StateOffline:
      return phone[0] ? phone : "No internet connection. Press Select to try again.";
    case StateError:
      return phone[0] ? phone : "The sync failed. Press Select to try again.";
    default:
      break;
  }
  if (model_count() == 0) {
    if (model_syncing()) {
      return "Looking for what is coming up...";
    }
    if (model_last_sync() == 0) {
      return "Not synced yet. Press Select to sync.";
    }
    return "Nothing is coming up in the window you chose in settings.";
  }
  return NULL;
}

// Status bar text; *alert is set for states the user has to act on.
static void prv_status_text(char *buf, size_t size, bool *alert) {
  *alert = false;
  if (model_syncing()) {
    snprintf(buf, size, "Syncing...");
    return;
  }
  *alert = true;
  switch (model_note()) {
    case NoteNoPhone: snprintf(buf, size, "Phone not connected"); return;
    case NoteNoAnswer: snprintf(buf, size, "Phone not answering"); return;
    default: break;
  }
  switch (model_state()) {
    case StateSignedOut: snprintf(buf, size, "Signed out"); return;
    case StateNeedsPlugins: snprintf(buf, size, "Check the Pebble app"); return;
    case StatePermission: snprintf(buf, size, "Permission needed"); return;
    case StateOffline: snprintf(buf, size, "Offline"); return;
    case StateError: snprintf(buf, size, "Sync failed"); return;
    default: break;
  }
  *alert = false;
  const time_t last = model_last_sync();
  if (last == 0) {
    snprintf(buf, size, "Not synced yet");
  } else if (ui_days_from_today(last) == 0) {
    char clock[12];
    ui_time_string(clock, sizeof(clock), last);
    snprintf(buf, size, "Synced %s", clock);
  } else {
    char day[20];
    ui_day_label(day, sizeof(day), last);
    snprintf(buf, size, "Synced %s", day);
  }
}

// Sections --------------------------------------------------------------------------------

static void prv_build_sections(void) {
  s_nsec = 0;
  const bool signed_out = model_state() == StateSignedOut && model_note() == NoteNone;
  if (signed_out) {
    s_sec[s_nsec++] = (Section){.type = SecSignin, .count = 1};
    return;
  }
  if (prv_message_text()) {
    s_sec[s_nsec++] = (Section){.type = SecMessage, .count = 1};
  }
  if (model_state() != StateSignedOut) {
    uint8_t i = 0;
    while (i < model_count() && s_nsec < MAX_SECTIONS - 1) {
      const Item *first = model_item(i);
      uint8_t j = i + 1;
      while (j < model_count() && ui_same_day(first->time, model_item(j)->time)) {
        j++;
      }
      s_sec[s_nsec++] = (Section){.type = SecDay, .first = i, .count = j - i,
                                  .day_time = first->time};
      i = j;
    }
  }
  s_sec[s_nsec++] = (Section){.type = SecAction, .count = 1};
}

static const Item *prv_item_at(const MenuIndex *index) {
  const Section *sec = &s_sec[index->section];
  return model_item(sec->first + index->row);
}

static MenuIndex prv_find_selection(void) {
  if (s_sel.valid) {
    for (uint8_t s = 0; s < s_nsec; s++) {
      if (s_sec[s].type != s_sel.type) {
        continue;
      }
      if (s_sec[s].type != SecDay) {
        return (MenuIndex){.section = s, .row = 0};
      }
      for (uint8_t r = 0; r < s_sec[s].count; r++) {
        const Item *item = model_item(s_sec[s].first + r);
        if (item->simkl == s_sel.simkl && item->season == s_sel.season &&
            item->episode == s_sel.episode) {
          return (MenuIndex){.section = s, .row = r};
        }
      }
    }
  }
  return (MenuIndex){.section = 0, .row = 0};
}

static void prv_refresh(void) {
  if (!s_menu) {
    return;
  }
  Section previous[MAX_SECTIONS];
  const uint8_t previous_count = s_nsec;
  memcpy(previous, s_sec, sizeof(previous));
  prv_build_sections();
  const bool same_shape = previous_count == s_nsec &&
                          memcmp(previous, s_sec, s_nsec * sizeof(Section)) == 0;
  menu_layer_reload_data(s_menu);
  if (!same_shape) {
    // A message or sign-in row that just appeared is what the user has to see first.
    const bool top_is_notice = s_nsec > 0 && (s_sec[0].type == SecMessage || s_sec[0].type == SecSignin);
    const bool was_notice = previous_count > 0 &&
                            (previous[0].type == SecMessage || previous[0].type == SecSignin);
    const MenuIndex target = top_is_notice && !was_notice ? (MenuIndex){.section = 0, .row = 0}
                                                          : prv_find_selection();
    menu_layer_set_selected_index(s_menu, target, MenuRowAlignCenter, false);
  }
  layer_mark_dirty(s_bar);
}

// Actions ---------------------------------------------------------------------------------

// A manual sync request. The status flips to Syncing at once; the phone confirms with STATUS.
static void prv_request_sync(void) {
  if (model_syncing()) {
    return;
  }
  if (comm_send_sync(SYNC_MANUAL)) {
    model_set_syncing(true);
  }
}

// Menu callbacks --------------------------------------------------------------------------

static uint16_t prv_num_sections(MenuLayer *menu, void *context) {
  return s_nsec;
}

static uint16_t prv_num_rows(MenuLayer *menu, uint16_t section, void *context) {
  return section < s_nsec ? s_sec[section].count : 0;
}

static int16_t prv_inset(void) {
  return UI_ROUND ? ui_pad() + s_menu_w / 12 : ui_pad();
}

static int16_t prv_header_height(MenuLayer *menu, uint16_t section, void *context) {
  if (section >= s_nsec || s_sec[section].type != SecDay) {
    return 0;
  }
  return ui_small_h() + 4;
}

static int16_t prv_text_row_height(const char *title, const char *body) {
  const int16_t w = s_menu_w - 2 * prv_inset();
  int16_t h = 10;
  if (title) {
    h += ui_text_block(NULL, title, ui_title_font(), 0, 0, w, GTextAlignmentLeft, 400) + 2;
  }
  if (body) {
    h += ui_text_block(NULL, body, ui_body_font(), 0, 0, w, GTextAlignmentLeft, 400);
  }
  return h;
}

static int16_t prv_round_focused_min(void) {
  return MENU_CELL_ROUND_FOCUSED_TALL_CELL_HEIGHT * PBL_DISPLAY_HEIGHT / 180;
}

static int16_t prv_cell_height(MenuLayer *menu, MenuIndex *index, void *context) {
  const Section *sec = &s_sec[index->section];
  switch (sec->type) {
    case SecDay: {
      if (!UI_ROUND) {
        return ui_title_h() + ui_small_h() + 8;
      }
      if (!menu_layer_is_index_selected(menu, index)) {
        return ui_title_h() + 10;
      }
      int16_t h = ui_title_h() + ui_small_h() + 12;
      if (ui_finale_text(prv_item_at(index))) {
        h += ui_small_h();
      }
      return h > prv_round_focused_min() ? h : prv_round_focused_min();
    }
    case SecMessage: {
      const int16_t h = prv_text_row_height(NULL, prv_message_text());
      return UI_ROUND && h < prv_round_focused_min() ? prv_round_focused_min() : h;
    }
    case SecSignin: {
      const int16_t h = prv_text_row_height("Sign in to Simkl", "Press Select to get a code.");
      return UI_ROUND && h < prv_round_focused_min() ? prv_round_focused_min() : h;
    }
    default:
      return ui_title_h() + (UI_ROUND ? 14 : 10);
  }
}

static GTextAlignment prv_align(void) {
  return UI_ROUND ? GTextAlignmentCenter : GTextAlignmentLeft;
}

static void prv_draw_header(GContext *ctx, const Layer *cell, uint16_t section, void *context) {
  const GRect bounds = layer_get_bounds(cell);
  char label[20];
  ui_day_label(label, sizeof(label), s_sec[section].day_time);
  graphics_context_set_fill_color(ctx, UI_HEADER_BG);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  graphics_context_set_text_color(ctx, GColorBlack);
  const int16_t inset = prv_inset();
  graphics_draw_text(ctx, label, ui_small_font(),
                     GRect(inset, -3, bounds.size.w - 2 * inset, bounds.size.h + 3),
                     GTextOverflowModeTrailingEllipsis, prv_align(), NULL);
#if defined(PBL_BW)
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_draw_line(ctx, GPoint(0, bounds.size.h - 1), GPoint(bounds.size.w, bounds.size.h - 1));
#endif
}

static void prv_draw_item(GContext *ctx, const Layer *cell, const Item *item, bool highlighted) {
  const GRect bounds = layer_get_bounds(cell);
  const bool focused = !UI_ROUND || highlighted;
  const int16_t inset = prv_inset();
  const int16_t w = bounds.size.w - 2 * inset;
  const GColor fg = highlighted ? GColorWhite : GColorBlack;
  const GTextAlignment align = prv_align();
  const char *finale = ui_finale_text(item);

  graphics_context_set_text_color(ctx, fg);
  if (!focused) {
    // Unfocused round rows show the title alone.
    graphics_draw_text(ctx, item->title, ui_body_font(),
                       GRect(inset, (bounds.size.h - ui_body_h()) / 2 - 3, w, ui_body_h() + 4),
                       GTextOverflowModeTrailingEllipsis, align, NULL);
    return;
  }

  char sub[48];
  ui_sub_line(sub, sizeof(sub), item);

  int16_t block = ui_title_h() + ui_small_h();
  if (UI_ROUND && finale) {
    block += ui_small_h();
  }
  int16_t y = (bounds.size.h - block) / 2;
  graphics_draw_text(ctx, item->title, ui_title_font(), GRect(inset, y - 4, w, ui_title_h() + 4),
                     GTextOverflowModeTrailingEllipsis, align, NULL);
  y += ui_title_h();

  int16_t sub_w = w;
  if (!UI_ROUND && finale) {
    // A small pill at the right end of the subtitle line.
    const int16_t pill_w = graphics_text_layout_get_content_size(
        "Finale", ui_small_font(), GRect(0, 0, 100, 30), GTextOverflowModeTrailingEllipsis,
        GTextAlignmentLeft).w + 8;
    const GRect pill = GRect(bounds.size.w - inset - pill_w, y + 1, pill_w, ui_small_h() - 2);
    graphics_context_set_fill_color(ctx, highlighted ? GColorWhite : UI_ACCENT);
    graphics_fill_rect(ctx, pill, 3, GCornersAll);
    graphics_context_set_text_color(ctx, highlighted ? UI_ACCENT : GColorWhite);
    graphics_draw_text(ctx, "Finale", ui_small_font(),
                       GRect(pill.origin.x, pill.origin.y - 3, pill.size.w, pill.size.h + 4),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
    graphics_context_set_text_color(ctx, fg);
    sub_w = w - pill_w - 4;
  }
  graphics_draw_text(ctx, sub, ui_small_font(), GRect(inset, y - 3, sub_w, ui_small_h() + 4),
                     GTextOverflowModeTrailingEllipsis, align, NULL);
  if (UI_ROUND && finale) {
    y += ui_small_h();
    graphics_draw_text(ctx, finale, ui_small_font(), GRect(inset, y - 3, w, ui_small_h() + 4),
                       GTextOverflowModeTrailingEllipsis, align, NULL);
  }
}

static void prv_draw_text_row(GContext *ctx, const Layer *cell, const char *title,
                              const char *body, bool highlighted) {
  const GRect bounds = layer_get_bounds(cell);
  const int16_t inset = prv_inset();
  const int16_t w = bounds.size.w - 2 * inset;
  graphics_context_set_text_color(ctx, highlighted ? GColorWhite : GColorBlack);
  int16_t y = 4;
  if (UI_ROUND) {
    const int16_t content = prv_text_row_height(title, body) - 10;
    y = (bounds.size.h - content) / 2;
  }
  if (title) {
    y += ui_text_block(ctx, title, ui_title_font(), inset, y, w, prv_align(), 400) + 2;
  }
  if (body) {
    ui_text_block(ctx, body, ui_body_font(), inset, y, w, prv_align(), 400);
  }
}

static void prv_draw_row(GContext *ctx, const Layer *cell, MenuIndex *index, void *context) {
  const Section *sec = &s_sec[index->section];
  const bool highlighted = menu_cell_layer_is_highlighted(cell);
  switch (sec->type) {
    case SecDay:
      prv_draw_item(ctx, cell, prv_item_at(index), highlighted);
      break;
    case SecMessage:
      prv_draw_text_row(ctx, cell, NULL, prv_message_text(), highlighted);
      break;
    case SecSignin:
      prv_draw_text_row(ctx, cell, "Sign in to Simkl", "Press Select to get a code.",
                        highlighted);
      break;
    default: {
      const GRect bounds = layer_get_bounds(cell);
      const int16_t inset = prv_inset();
      graphics_context_set_text_color(ctx, highlighted ? GColorWhite : GColorBlack);
      graphics_draw_text(ctx, model_syncing() ? "Syncing..." : "Sync now", ui_title_font(),
                         GRect(inset, (bounds.size.h - ui_title_h()) / 2 - 4,
                               bounds.size.w - 2 * inset, ui_title_h() + 4),
                         GTextOverflowModeTrailingEllipsis,
                         UI_ROUND ? GTextAlignmentCenter : GTextAlignmentLeft, NULL);
      break;
    }
  }
}

static void prv_select(MenuLayer *menu, MenuIndex *index, void *context) {
  switch (s_sec[index->section].type) {
    case SecDay: {
      const Item *item = prv_item_at(index);
      if (item) {
        detail_win_push(item);
      }
      break;
    }
    case SecSignin:
      signin_win_push();
      break;
    default:
      prv_request_sync();
      break;
  }
}

static void prv_select_long(MenuLayer *menu, MenuIndex *index, void *context) {
  if (s_sec[index->section].type != SecSignin) {
    prv_request_sync();
  }
}

static void prv_selection_changed(MenuLayer *menu, MenuIndex new_index, MenuIndex old_index,
                                  void *context) {
  if (new_index.section >= s_nsec) {
    return;
  }
  const Section *sec = &s_sec[new_index.section];
  s_sel = (SelectionKey){.valid = true, .type = sec->type, .simkl = -1, .season = -1,
                         .episode = -1};
  if (sec->type == SecDay) {
    const Item *item = model_item(sec->first + new_index.row);
    if (item) {
      s_sel.simkl = item->simkl;
      s_sel.season = item->season;
      s_sel.episode = item->episode;
    }
  }
}

// Status bar ------------------------------------------------------------------------------

static void prv_bar_update(Layer *layer, GContext *ctx) {
  const GRect bounds = layer_get_bounds(layer);
  char text[40];
  bool alert;
  prv_status_text(text, sizeof(text), &alert);
  graphics_context_set_fill_color(ctx, alert ? UI_ACCENT : UI_BAR_OK);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  graphics_context_set_text_color(ctx, GColorWhite);
  const int16_t inset = UI_ROUND ? bounds.size.w / 5 : ui_pad();
  graphics_draw_text(ctx, text, ui_small_font(),
                     GRect(inset, UI_ROUND ? bounds.size.h - ui_small_h() - 1 : -3,
                           bounds.size.w - 2 * inset, ui_small_h() + 4),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

// Window ----------------------------------------------------------------------------------

static void prv_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  const GRect bounds = layer_get_bounds(root);
  s_menu_w = bounds.size.w;
  s_bar_h = ui_small_h() + (UI_ROUND ? 14 : 2);

  GRect menu_frame = bounds;
  if (!UI_ROUND) {
    menu_frame.origin.y = s_bar_h;
    menu_frame.size.h -= s_bar_h;
  }
  s_menu = menu_layer_create(menu_frame);
  menu_layer_set_normal_colors(s_menu, GColorWhite, GColorBlack);
  menu_layer_set_highlight_colors(s_menu, UI_ACCENT, GColorWhite);
  menu_layer_set_center_focused(s_menu, UI_ROUND);
  menu_layer_set_callbacks(s_menu, NULL, (MenuLayerCallbacks){
      .get_num_sections = prv_num_sections,
      .get_num_rows = prv_num_rows,
      .get_cell_height = prv_cell_height,
      .get_header_height = prv_header_height,
      .draw_row = prv_draw_row,
      .draw_header = prv_draw_header,
      .select_click = prv_select,
      .select_long_click = prv_select_long,
      .selection_changed = prv_selection_changed,
  });
  menu_layer_set_click_config_onto_window(s_menu, window);
  layer_add_child(root, menu_layer_get_layer(s_menu));

  s_bar = layer_create(GRect(0, 0, bounds.size.w, s_bar_h));
  layer_set_update_proc(s_bar, prv_bar_update);
  layer_add_child(root, s_bar);

  prv_build_sections();
  menu_layer_reload_data(s_menu);
  menu_layer_set_selected_index(s_menu, prv_find_selection(), MenuRowAlignCenter, false);
  model_set_listener(prv_refresh);
}

// Day labels depend on today's date, so rebuild whenever the list comes back into view.
static void prv_appear(Window *window) {
  prv_refresh();
}

static void prv_unload(Window *window) {
  model_set_listener(NULL);
  layer_destroy(s_bar);
  menu_layer_destroy(s_menu);
  s_bar = NULL;
  s_menu = NULL;
  window_destroy(s_window);
  s_window = NULL;
}

void main_win_push(void) {
  if (s_window) {
    return;
  }
  s_window = window_create();
  window_set_background_color(s_window, GColorWhite);
  window_set_window_handlers(s_window, (WindowHandlers){
      .load = prv_load,
      .appear = prv_appear,
      .unload = prv_unload,
  });
  window_stack_push(s_window, true);
}
