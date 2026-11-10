#pragma once
#include <pebble.h>

#define MAX_ITEMS 16
#define TITLE_LEN 40
#define SUB_LEN 24
#define DETAIL_LEN 40
#define NETWORK_LEN 20
#define STATUS_TEXT_LEN 96

// ItemFlags bits (contract): 0-1 kind, 2 all day, 3-4 finale, 5 digital release.
#define ITEM_KIND(f) ((f) & 3)
#define ITEM_ALL_DAY(f) (((f) >> 2) & 1)
#define ITEM_FINALE(f) (((f) >> 3) & 3)
#define ITEM_DIGITAL(f) (((f) >> 5) & 1)
#define ITEM_KIND_TV 0
#define ITEM_KIND_ANIME 1
#define ITEM_KIND_MOVIE 2

typedef struct {
  int32_t time;
  int32_t simkl;
  int16_t season;   // -1 when none
  int16_t episode;  // -1 when none
  int16_t runtime;  // minutes, 0 unknown
  uint8_t flags;
  uint8_t reserved;
  char title[TITLE_LEN];
  char sub[SUB_LEN];
  char detail[DETAIL_LEN];
  char network[NETWORK_LEN];
} Item;

// STATUS.State from the phone. Syncing is kept apart from the persisted state.
typedef enum {
  StateReady = 0,
  StateSyncing = 1,
  StateSignedOut = 2,
  StateNeedsPlugins = 3,
  StatePermission = 4,
  StateOffline = 5,
  StateError = 6,
} SyncState;

// Local facts about the phone link, not persisted. Cleared by any message from the phone.
typedef enum {
  NoteNone = 0,
  NoteNoPhone,
  NoteNoAnswer,
} Note;

typedef void (*ModelListener)(void);

void model_load(void);
void model_unload(void);
void model_set_listener(ModelListener listener);

uint8_t model_count(void);
const Item *model_item(uint8_t index);

// Items arrive as BEGIN, ITEM x count, END. They are staged and only replace the shown list
// when every index arrived.
bool model_items_begin(uint8_t count);
void model_items_put(uint8_t index, const Item *item);
bool model_items_end(uint8_t count, time_t last_sync);

void model_set_status(SyncState state, const char *text, bool has_last_sync, time_t last_sync);
SyncState model_state(void);
const char *model_text(void);
time_t model_last_sync(void);

bool model_syncing(void);
void model_set_syncing(bool syncing);

Note model_note(void);
void model_set_note(Note note);

int16_t model_sync_time(uint8_t slot);
void model_set_schedule(int16_t first, int16_t second);
