#include "glance.h"

#include <string.h>

#include "model.h"

#if !defined(PBL_PLATFORM_APLITE)

// The template string may not exceed 150 bytes.
#define TEMPLATE_MAX 150

// Copies src into dst, replacing the template metacharacters and stopping at max bytes without
// splitting a UTF-8 sequence.
static size_t prv_escape_append(char *dst, size_t used, size_t max, const char *src) {
  for (; *src; src++) {
    char c = *src == '{' ? '(' : *src == '}' ? ')' : *src;
    const bool is_lead_or_ascii = ((uint8_t)c & 0xC0) != 0x80;
    if (is_lead_or_ascii) {
      // Look ahead: a lead byte needs its continuation bytes to fit too.
      size_t need = 1;
      if (((uint8_t)c & 0xE0) == 0xC0) need = 2;
      else if (((uint8_t)c & 0xF0) == 0xE0) need = 3;
      else if (((uint8_t)c & 0xF8) == 0xF0) need = 4;
      if (used + need > max) {
        break;
      }
    } else if (used + 1 > max) {
      break;
    }
    dst[used++] = c;
  }
  dst[used] = '\0';
  return used;
}

static void prv_reload(AppGlanceReloadSession *session, size_t limit, void *context) {
  const time_t now = time(NULL);
  size_t added = 0;
  for (uint8_t i = 0; i < model_count() && added < limit; i++) {
    const Item *item = model_item(i);
    if (item->time <= now) {
      continue;
    }
    // "In 2 hr 10 min: <title>, <sub>". The launcher evaluates the countdown itself, so it
    // stays right without the app running, and it comes first so truncation cuts the title.
    char prefix[110];
    snprintf(prefix, sizeof(prefix),
             "In {time_until(%ld)|format(>=1d:'%%ud',>=1H:'%%aH %%aM',>0S:'%%aM')}: ",
             (long)item->time);
    char tpl[TEMPLATE_MAX + 1];
    const size_t prefix_len = strlen(prefix);
    strcpy(tpl, prefix);
    // The prefix holds the template syntax itself, so only the item text is escaped.
    size_t used = prefix_len;
    used = prv_escape_append(tpl, used, TEMPLATE_MAX, item->title);
    if (item->sub[0]) {
      used = prv_escape_append(tpl, used, TEMPLATE_MAX, ", ");
      prv_escape_append(tpl, used, TEMPLATE_MAX, item->sub);
    }

    const AppGlanceSlice slice = {
        .layout = {.icon = APP_GLANCE_SLICE_DEFAULT_ICON, .subtitle_template_string = tpl},
        .expiration_time = item->time,
    };
    const AppGlanceResult result = app_glance_add_slice(session, slice);
    if (result != APP_GLANCE_RESULT_SUCCESS) {
      APP_LOG(APP_LOG_LEVEL_WARNING, "glance slice rejected: %d", (int)result);
      break;
    }
    added++;
  }
}

void glance_update(void) {
  // Signed out: clear the glance instead of advertising stale items.
  app_glance_reload(model_state() == StateSignedOut ? NULL : prv_reload, NULL);
}

#else

void glance_update(void) {}

#endif
