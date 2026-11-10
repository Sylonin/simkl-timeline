#include "ui.h"

#include <string.h>

// Gabbro and emery have more pixels than the 144x168 classics, so they step up one font size.
#if defined(PBL_PLATFORM_GABBRO)
#define TITLE_KEY FONT_KEY_GOTHIC_28_BOLD
#define BODY_KEY FONT_KEY_GOTHIC_24
#define SMALL_KEY FONT_KEY_GOTHIC_18
#elif defined(PBL_PLATFORM_EMERY)
#define TITLE_KEY FONT_KEY_GOTHIC_24_BOLD
#define BODY_KEY FONT_KEY_GOTHIC_24
#define SMALL_KEY FONT_KEY_GOTHIC_18
#else
#define TITLE_KEY FONT_KEY_GOTHIC_18_BOLD
#define BODY_KEY FONT_KEY_GOTHIC_18
#define SMALL_KEY FONT_KEY_GOTHIC_14
#endif
#define CODE_KEY FONT_KEY_GOTHIC_28_BOLD

static int16_t s_title_h;
static int16_t s_body_h;
static int16_t s_small_h;
static int16_t s_code_h;

static int16_t prv_line_h(GFont font) {
  const GSize size = graphics_text_layout_get_content_size(
      "Ag", font, GRect(0, 0, 200, 200), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft);
  return size.h;
}

void ui_init(void) {
  s_title_h = prv_line_h(ui_title_font());
  s_body_h = prv_line_h(ui_body_font());
  s_small_h = prv_line_h(ui_small_font());
  s_code_h = prv_line_h(ui_code_font());
}

GFont ui_title_font(void) { return fonts_get_system_font(TITLE_KEY); }
GFont ui_body_font(void) { return fonts_get_system_font(BODY_KEY); }
GFont ui_small_font(void) { return fonts_get_system_font(SMALL_KEY); }
GFont ui_code_font(void) { return fonts_get_system_font(CODE_KEY); }
int16_t ui_title_h(void) { return s_title_h; }
int16_t ui_body_h(void) { return s_body_h; }
int16_t ui_small_h(void) { return s_small_h; }
int16_t ui_code_h(void) { return s_code_h; }

int16_t ui_pad(void) {
#if defined(PBL_PLATFORM_GABBRO)
  return 22;
#elif defined(PBL_ROUND)
  return 14;
#elif defined(PBL_PLATFORM_EMERY)
  return 8;
#else
  return 6;
#endif
}

void ui_time_string(char *buf, size_t size, time_t t) {
  struct tm *tm = localtime(&t);
  strftime(buf, size, clock_is_24h_style() ? "%H:%M" : "%I:%M %p", tm);
  if (!clock_is_24h_style() && buf[0] == '0') {
    memmove(buf, buf + 1, strlen(buf));
  }
}

static int prv_local_day(time_t t) {
  struct tm *tm = localtime(&t);
  const int offset = tm->tm_gmtoff;
  return (int)((t + offset) / SECONDS_PER_DAY);
}

int ui_days_from_today(time_t t) {
  return prv_local_day(t) - prv_local_day(time(NULL));
}

bool ui_same_day(time_t a, time_t b) {
  return prv_local_day(a) == prv_local_day(b);
}

void ui_day_label(char *buf, size_t size, time_t t) {
  const int days = ui_days_from_today(t);
  if (days == 0) {
    strncpy(buf, "Today", size);
  } else if (days == 1) {
    strncpy(buf, "Tomorrow", size);
  } else if (days == -1) {
    strncpy(buf, "Yesterday", size);
  } else {
    struct tm *tm = localtime(&t);
    strftime(buf, size, "%a %d %b", tm);
    // "Wed 03 Nov" -> "Wed 3 Nov"
    if (strlen(buf) > 5 && buf[4] == '0') {
      memmove(buf + 4, buf + 5, strlen(buf + 5) + 1);
    }
  }
  buf[size - 1] = '\0';
}

void ui_when_string(char *buf, size_t size, const Item *item) {
  char day[20];
  ui_day_label(day, sizeof(day), item->time);
  if (ITEM_ALL_DAY(item->flags)) {
    snprintf(buf, size, "%s", day);
    return;
  }
  char clock[12];
  ui_time_string(clock, sizeof(clock), item->time);
  snprintf(buf, size, "%s, %s", day, clock);
}

void ui_sub_line(char *buf, size_t size, const Item *item) {
  if (ITEM_ALL_DAY(item->flags)) {
    snprintf(buf, size, "%s", item->sub);
    return;
  }
  char clock[12];
  ui_time_string(clock, sizeof(clock), item->time);
  if (item->sub[0]) {
    snprintf(buf, size, "%s \xC2\xB7 %s", clock, item->sub);
  } else {
    snprintf(buf, size, "%s", clock);
  }
}

const char *ui_finale_text(const Item *item) {
  switch (ITEM_FINALE(item->flags)) {
    case 1: return "Mid-season finale";
    case 2: return "Season finale";
    case 3: return "Series finale";
    default: return NULL;
  }
}

int16_t ui_text_block(GContext *ctx, const char *text, GFont font, int16_t x, int16_t y,
                      int16_t w, GTextAlignment align, int16_t max_h) {
  GRect box = GRect(x, y, w, max_h);
  const GSize size = graphics_text_layout_get_content_size(text, font, box,
                                                           GTextOverflowModeWordWrap, align);
  if (ctx) {
    box.size.h = size.h + 2;
    graphics_draw_text(ctx, text, font, box, GTextOverflowModeWordWrap, align, NULL);
  }
  return size.h;
}
