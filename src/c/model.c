#include "model.h"

#include <string.h>

// Persistent storage layout (limits: 256 B per key, 4 KB per app):
//   key 1        Meta, 108 B: version, item count, last STATUS state (never Syncing), LastSync,
//                the two sync times, STATUS text.
//   keys 16..31  one Item each, 140 B, in list order.
// Worst case 108 + 16 * 140 = 2348 B. Meta.version guards the layout; anything unreadable or
// from another version is dropped and the app starts empty.
#define PERSIST_META 1
#define PERSIST_ITEM_BASE 16
#define META_VERSION 1

// Default first sync time (06:00) until the phone sends a SCHEDULE.
#define DEFAULT_SYNC_FIRST 360
// The phone's own sync loop is capped at about 50 s.
#define SYNCING_TIMEOUT_MS 75000

typedef struct {
  uint8_t version;
  uint8_t count;
  uint8_t state;
  uint8_t reserved;
  int32_t last_sync;
  int16_t sync_time[2];
  char text[STATUS_TEXT_LEN];
} Meta;

_Static_assert(sizeof(Item) <= PERSIST_DATA_MAX_LENGTH, "Item must fit one persist key");
_Static_assert(sizeof(Meta) <= PERSIST_DATA_MAX_LENGTH, "Meta must fit one persist key");

static Item *s_items;
static uint8_t s_count;

static Item *s_stage;
static uint8_t s_stage_count;
static uint16_t s_stage_mask;

static Meta s_meta;
static Meta s_meta_saved;
static bool s_meta_saved_valid;

static bool s_syncing;
static AppTimer *s_syncing_timer;
static Note s_note;
static ModelListener s_listener;

static void prv_notify(void) {
  if (s_listener) {
    s_listener();
  }
}

static void prv_save_meta(void) {
  if (s_meta_saved_valid && memcmp(&s_meta, &s_meta_saved, sizeof(Meta)) == 0) {
    return;
  }
  persist_write_data(PERSIST_META, &s_meta, sizeof(Meta));
  s_meta_saved = s_meta;
  s_meta_saved_valid = true;
}

static void prv_default_meta(void) {
  memset(&s_meta, 0, sizeof(Meta));
  s_meta.version = META_VERSION;
  s_meta.sync_time[0] = DEFAULT_SYNC_FIRST;
  s_meta.sync_time[1] = -1;
}

// Copies the phone's status text, swapping the arrow (U+2192) that the system fonts lack for ">".
static void prv_copy_str(char *dst, size_t size, const char *src) {
  size_t out = 0;
  for (; src && *src && out < size - 1; src++) {
    if ((uint8_t)src[0] == 0xE2 && (uint8_t)src[1] == 0x86 && (uint8_t)src[2] == 0x92) {
      dst[out++] = '>';
      src += 2;
    } else {
      dst[out++] = *src;
    }
  }
  dst[out] = '\0';
}

// Reads the persisted items into RAM. Leaves the list empty when any of them is unreadable.
static void prv_load_items(void) {
  free(s_items);
  s_items = NULL;
  s_count = 0;
  const uint8_t count = s_meta.count;
  if (count == 0 || count > MAX_ITEMS) {
    return;
  }
  Item *items = malloc(count * sizeof(Item));
  bool ok = items != NULL;
  for (uint8_t i = 0; ok && i < count; i++) {
    ok = persist_read_data(PERSIST_ITEM_BASE + i, &items[i], sizeof(Item)) == (int)sizeof(Item);
  }
  if (ok) {
    s_items = items;
    s_count = count;
  } else {
    free(items);
  }
}

void model_load(void) {
  prv_default_meta();
  s_count = 0;
  Meta meta;
  if (persist_exists(PERSIST_META) &&
      persist_get_size(PERSIST_META) == (int)sizeof(Meta) &&
      persist_read_data(PERSIST_META, &meta, sizeof(Meta)) == (int)sizeof(Meta) &&
      meta.version == META_VERSION && meta.count <= MAX_ITEMS) {
    meta.text[STATUS_TEXT_LEN - 1] = '\0';
    s_meta = meta;
    s_meta_saved = meta;
    s_meta_saved_valid = true;
    prv_load_items();
    if (s_count == 0) {
      s_meta.count = 0;
    }
  }
}

void model_unload(void) {
  if (s_syncing_timer) {
    app_timer_cancel(s_syncing_timer);
    s_syncing_timer = NULL;
  }
  free(s_items);
  free(s_stage);
  s_items = NULL;
  s_stage = NULL;
  s_count = 0;
}

void model_set_listener(ModelListener listener) {
  s_listener = listener;
}

uint8_t model_count(void) {
  return s_count;
}

const Item *model_item(uint8_t index) {
  return index < s_count ? &s_items[index] : NULL;
}

bool model_items_begin(uint8_t count) {
  free(s_stage);
  s_stage = NULL;
  s_stage_count = 0;
  s_stage_mask = 0;
  if (count > MAX_ITEMS) {
    return false;
  }
  s_stage_count = count;
  if (count > 0) {
    s_stage = calloc(count, sizeof(Item));
    if (!s_stage && s_items) {
      // Aplite has little heap: drop the shown list (it is persisted) to make room, and let
      // an incomplete transfer reload it from storage.
      free(s_items);
      s_items = NULL;
      s_count = 0;
      prv_notify();
      s_stage = calloc(count, sizeof(Item));
    }
    if (!s_stage) {
      s_stage_count = 0;
      return false;
    }
  }
  return true;
}

void model_items_put(uint8_t index, const Item *item) {
  if (!s_stage || index >= s_stage_count) {
    return;
  }
  s_stage[index] = *item;
  s_stage_mask |= (uint16_t)(1u << index);
}

bool model_items_end(uint8_t count, time_t last_sync) {
  const uint16_t want = count >= 16 ? 0xFFFF : (uint16_t)((1u << count) - 1);
  const bool complete = count == s_stage_count && s_stage_mask == want;
  if (!complete) {
    APP_LOG(APP_LOG_LEVEL_WARNING, "item transfer incomplete, keeping the old list");
    free(s_stage);
    s_stage = NULL;
    s_stage_count = 0;
    s_stage_mask = 0;
    if (!s_items && s_meta.count > 0) {
      prv_load_items();
      prv_notify();
    }
    return false;
  }

  const bool same = count == s_count &&
                    (count == 0 || memcmp(s_stage, s_items, count * sizeof(Item)) == 0);
  if (!same) {
    free(s_items);
    s_items = s_stage;
    for (uint8_t i = 0; i < count; i++) {
      persist_write_data(PERSIST_ITEM_BASE + i, &s_items[i], sizeof(Item));
    }
    for (uint8_t i = count; i < s_count; i++) {
      persist_delete(PERSIST_ITEM_BASE + i);
    }
    s_count = count;
  } else {
    free(s_stage);
  }
  s_stage = NULL;
  s_stage_count = 0;
  s_stage_mask = 0;

  s_meta.count = s_count;
  if (last_sync > 0) {
    s_meta.last_sync = (int32_t)last_sync;
  }
  prv_save_meta();
  prv_notify();
  return true;
}

static void prv_syncing_timeout(void *data) {
  s_syncing_timer = NULL;
  s_syncing = false;
  s_note = NoteNoAnswer;
  prv_notify();
}

void model_set_syncing(bool syncing) {
  if (s_syncing_timer) {
    app_timer_cancel(s_syncing_timer);
    s_syncing_timer = NULL;
  }
  s_syncing = syncing;
  if (syncing) {
    s_syncing_timer = app_timer_register(SYNCING_TIMEOUT_MS, prv_syncing_timeout, NULL);
  }
  prv_notify();
}

void model_set_status(SyncState state, const char *text, bool has_last_sync, time_t last_sync) {
  if (has_last_sync) {
    s_meta.last_sync = (int32_t)last_sync;
  }
  if (state == StateSyncing) {
    model_set_syncing(true);
    prv_save_meta();
    return;
  }
  s_meta.state = (uint8_t)state;
  if (state == StateReady) {
    s_meta.text[0] = '\0';
  } else {
    prv_copy_str(s_meta.text, sizeof(s_meta.text), text);
  }
  prv_save_meta();
  model_set_syncing(false);
}

SyncState model_state(void) {
  return (SyncState)s_meta.state;
}

const char *model_text(void) {
  return s_meta.text;
}

time_t model_last_sync(void) {
  return (time_t)s_meta.last_sync;
}

bool model_syncing(void) {
  return s_syncing;
}

Note model_note(void) {
  return s_note;
}

void model_set_note(Note note) {
  if (note == NoteNone && s_note == NoteNone) {
    return;
  }
  s_note = note;
  if (note != NoteNone && s_syncing) {
    model_set_syncing(false);
    return;
  }
  prv_notify();
}

int16_t model_sync_time(uint8_t slot) {
  return slot < 2 ? s_meta.sync_time[slot] : -1;
}

void model_set_schedule(int16_t first, int16_t second) {
  s_meta.sync_time[0] = first;
  s_meta.sync_time[1] = second;
  prv_save_meta();
}
