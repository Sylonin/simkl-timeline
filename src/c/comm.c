#include "comm.h"

#include <string.h>

#include "detail_win.h"
#include "signin_win.h"
#include "wake.h"

// Biggest phone -> watch message is SIGNIN_CODE: the code, expiry, size and up to 256 B of QR
// modules (QR versions up to 7). ITEM is about 250 B. Watch -> phone messages are 5 integers.
#define INBOX_SIZE 400
#define OUTBOX_SIZE 72
#define QR_MAX_BYTES 256

#define QUEUE_LEN 4
#define MAX_RETRIES 2
// The phone sync loop is capped at about 50 s; this only guards against a lost end marker.
#define SNIFF_SAFETY_MS 60000
// How long to wait for READY before sending anyway: a phone app that kept the JavaScript
// running from an earlier launch doesn't fire its ready event again.
#define JS_READY_WAIT_MS 6000

enum {
  InStatus = 10,
  InItemsBegin = 11,
  InItem = 12,
  InItemsEnd = 13,
  InSigninCode = 14,
  InSigninResult = 15,
  InSchedule = 16,
  InResult = 17,
  InReady = 18,
};

typedef struct {
  uint8_t cmd;
  int32_t v[4];
} OutMsg;

static OutMsg s_queue[QUEUE_LEN];
static uint8_t s_queue_len;
static bool s_in_flight;
static uint8_t s_retries;
static AppTimer *s_retry_timer;
static AppTimer *s_sniff_timer;
static AppTimer *s_ready_timer;
// Messages wait in the queue until the phone's JavaScript says it is listening.
static bool s_js_ready;
// The launch HELLO until a STATUS answers it, so a late READY can ask again.
static int s_hello_reason;
static bool s_hello_unanswered;

static void prv_pump(void);

static bool prv_int(DictionaryIterator *iter, uint32_t key, int32_t *out) {
  const Tuple *t = dict_find(iter, key);
  if (!t) {
    return false;
  }
  const bool is_signed = t->type == TUPLE_INT;
  switch (t->length) {
    case 1: *out = is_signed ? t->value->int8 : t->value->uint8; return true;
    case 2: *out = is_signed ? t->value->int16 : t->value->uint16; return true;
    case 4: *out = is_signed ? t->value->int32 : (int32_t)t->value->uint32; return true;
    default: return false;
  }
}

static int32_t prv_int_or(DictionaryIterator *iter, uint32_t key, int32_t fallback) {
  int32_t v;
  return prv_int(iter, key, &v) ? v : fallback;
}

static const char *prv_str(DictionaryIterator *iter, uint32_t key) {
  const Tuple *t = dict_find(iter, key);
  return t && t->type == TUPLE_CSTRING ? t->value->cstring : "";
}

static void prv_copy(char *dst, size_t size, const char *src) {
  strncpy(dst, src, size - 1);
  dst[size - 1] = '\0';
}

static void prv_sniff_timeout(void *data) {
  s_sniff_timer = NULL;
  app_comm_set_sniff_interval(SNIFF_INTERVAL_NORMAL);
}

void comm_transfer_begin(void) {
  app_comm_set_sniff_interval(SNIFF_INTERVAL_REDUCED);
  if (s_sniff_timer) {
    app_timer_reschedule(s_sniff_timer, SNIFF_SAFETY_MS);
  } else {
    s_sniff_timer = app_timer_register(SNIFF_SAFETY_MS, prv_sniff_timeout, NULL);
  }
}

void comm_transfer_end(void) {
  if (s_sniff_timer) {
    app_timer_cancel(s_sniff_timer);
    s_sniff_timer = NULL;
  }
  app_comm_set_sniff_interval(SNIFF_INTERVAL_NORMAL);
}

static void prv_dispatch_failure(uint8_t cmd) {
  model_set_note(NoteNoPhone);
  comm_transfer_end();
  wake_on_send_failed(cmd);
  signin_win_on_send_failed(cmd);
  detail_win_on_send_failed(cmd);
}

static void prv_pop(void) {
  memmove(&s_queue[0], &s_queue[1], (s_queue_len - 1) * sizeof(OutMsg));
  s_queue_len--;
  s_in_flight = false;
  s_retries = 0;
}

static void prv_retry(void *data) {
  s_retry_timer = NULL;
  s_in_flight = false;
  prv_pump();
}

static void prv_pump(void) {
  if (!s_js_ready || s_in_flight || s_queue_len == 0) {
    return;
  }
  const OutMsg *m = &s_queue[0];
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) {
    const uint8_t cmd = m->cmd;
    prv_pop();
    prv_dispatch_failure(cmd);
    prv_pump();
    return;
  }
  dict_write_int32(iter, MESSAGE_KEY_Cmd, m->cmd);
  switch (m->cmd) {
    case CmdHello:
    case CmdSync:
      dict_write_int32(iter, MESSAGE_KEY_Reason, m->v[0]);
      break;
    case CmdMarkWatched:
      dict_write_int32(iter, MESSAGE_KEY_ItemFlags, m->v[0]);
      dict_write_int32(iter, MESSAGE_KEY_ItemSimkl, m->v[1]);
      dict_write_int32(iter, MESSAGE_KEY_ItemSeason, m->v[2]);
      dict_write_int32(iter, MESSAGE_KEY_ItemEpisode, m->v[3]);
      break;
    default:
      break;
  }
  dict_write_end(iter);
  if (app_message_outbox_send() == APP_MSG_OK) {
    s_in_flight = true;
  } else {
    const uint8_t cmd = m->cmd;
    prv_pop();
    prv_dispatch_failure(cmd);
    prv_pump();
  }
}

static bool prv_enqueue(uint8_t cmd, int32_t a, int32_t b, int32_t c, int32_t d) {
  if (!connection_service_peek_pebble_app_connection()) {
    prv_dispatch_failure(cmd);
    return false;
  }
  if (s_queue_len == QUEUE_LEN) {
    APP_LOG(APP_LOG_LEVEL_WARNING, "outbox queue full, dropping command %d", cmd);
    return false;
  }
  // A new attempt supersedes an earlier "phone not connected / not answering" note.
  model_set_note(NoteNone);
  s_queue[s_queue_len++] = (OutMsg){.cmd = cmd, .v = {a, b, c, d}};
  prv_pump();
  return true;
}

bool comm_send_hello(int reason) {
  s_hello_reason = reason;
  s_hello_unanswered = true;
  comm_transfer_begin();
  return prv_enqueue(CmdHello, reason, 0, 0, 0);
}

bool comm_send_sync(int reason) {
  comm_transfer_begin();
  return prv_enqueue(CmdSync, reason, 0, 0, 0);
}

bool comm_send_signin_start(void) {
  comm_transfer_begin();
  return prv_enqueue(CmdSigninStart, 0, 0, 0, 0);
}

void comm_send_signin_stop(void) {
  if (connection_service_peek_pebble_app_connection() && s_queue_len < QUEUE_LEN) {
    s_queue[s_queue_len++] = (OutMsg){.cmd = CmdSigninStop};
    prv_pump();
  }
}

bool comm_send_mark_watched(const Item *item) {
  comm_transfer_begin();
  return prv_enqueue(CmdMarkWatched, item->flags, item->simkl, item->season, item->episode);
}

static void prv_outbox_sent(DictionaryIterator *iter, void *context) {
  prv_pop();
  prv_pump();
}

static void prv_outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  const uint8_t cmd = s_queue[0].cmd;
  if (reason != APP_MSG_NOT_CONNECTED && s_retries < MAX_RETRIES) {
    s_retries++;
    s_retry_timer = app_timer_register(500 * s_retries, prv_retry, NULL);
    return;
  }
  prv_pop();
  prv_dispatch_failure(cmd);
  prv_pump();
}

static void prv_handle_status(DictionaryIterator *iter) {
  const SyncState state = (SyncState)prv_int_or(iter, MESSAGE_KEY_State, StateError);
  s_hello_unanswered = false;
  int32_t last_sync = 0;
  const bool has_last_sync = prv_int(iter, MESSAGE_KEY_LastSync, &last_sync);
  model_set_status(state, prv_str(iter, MESSAGE_KEY_Text), has_last_sync, (time_t)last_sync);
  if (state == StateSyncing) {
    // Items follow once the phone finishes.
    comm_transfer_begin();
  } else if (state != StateReady) {
    comm_transfer_end();
  }
  wake_on_status(state);
}

static void prv_handle_item(DictionaryIterator *iter) {
  Item item;
  memset(&item, 0, sizeof(item));
  item.time = prv_int_or(iter, MESSAGE_KEY_ItemTime, 0);
  item.flags = (uint8_t)prv_int_or(iter, MESSAGE_KEY_ItemFlags, 0);
  item.runtime = (int16_t)prv_int_or(iter, MESSAGE_KEY_ItemRuntime, 0);
  item.simkl = prv_int_or(iter, MESSAGE_KEY_ItemSimkl, 0);
  item.season = (int16_t)prv_int_or(iter, MESSAGE_KEY_ItemSeason, -1);
  item.episode = (int16_t)prv_int_or(iter, MESSAGE_KEY_ItemEpisode, -1);
  prv_copy(item.title, sizeof(item.title), prv_str(iter, MESSAGE_KEY_ItemTitle));
  prv_copy(item.sub, sizeof(item.sub), prv_str(iter, MESSAGE_KEY_ItemSub));
  prv_copy(item.detail, sizeof(item.detail), prv_str(iter, MESSAGE_KEY_ItemDetail));
  prv_copy(item.network, sizeof(item.network), prv_str(iter, MESSAGE_KEY_ItemNetwork));
  const int32_t index = prv_int_or(iter, MESSAGE_KEY_Index, -1);
  if (index >= 0 && index < MAX_ITEMS) {
    model_items_put((uint8_t)index, &item);
  }
}

static void prv_handle_signin_code(DictionaryIterator *iter) {
  const Tuple *qr = dict_find(iter, MESSAGE_KEY_QrData);
  const int32_t size = prv_int_or(iter, MESSAGE_KEY_QrSize, 0);
  const bool qr_ok = qr && size > 0 && size <= 177 &&
                     qr->length >= ((uint32_t)size * (uint32_t)size + 7) / 8 &&
                     qr->length <= QR_MAX_BYTES;
  signin_win_on_code(prv_str(iter, MESSAGE_KEY_Code), (time_t)prv_int_or(iter, MESSAGE_KEY_Expires, 0),
                     qr_ok ? (uint8_t)size : 0, qr_ok ? qr->value->data : NULL,
                     qr_ok ? qr->length : 0);
}

static bool prv_queued(uint8_t cmd) {
  for (uint8_t i = 0; i < s_queue_len; i++) {
    if (s_queue[i].cmd == cmd) {
      return true;
    }
  }
  return false;
}

static void prv_set_js_ready(void) {
  if (s_ready_timer) {
    app_timer_cancel(s_ready_timer);
    s_ready_timer = NULL;
  }
  s_js_ready = true;
  prv_pump();
}

static void prv_on_ready(void) {
  const bool late = s_js_ready;
  prv_set_js_ready();
  // A HELLO sent on the fallback timer before the JavaScript loaded was lost; ask again.
  if (late && s_hello_unanswered && !prv_queued(CmdHello)) {
    comm_send_hello(s_hello_reason);
  }
}

static void prv_ready_timeout(void *data) {
  s_ready_timer = NULL;
  prv_set_js_ready();
}

static void prv_inbox_received(DictionaryIterator *iter, void *context) {
  model_set_note(NoteNone);
  switch (prv_int_or(iter, MESSAGE_KEY_Cmd, 0)) {
    case InReady:
      prv_on_ready();
      break;
    case InStatus:
      prv_handle_status(iter);
      break;
    case InItemsBegin:
      model_items_begin((uint8_t)prv_int_or(iter, MESSAGE_KEY_Count, 0));
      break;
    case InItem:
      prv_handle_item(iter);
      break;
    case InItemsEnd: {
      int32_t last_sync = 0;
      prv_int(iter, MESSAGE_KEY_LastSync, &last_sync);
      model_items_end((uint8_t)prv_int_or(iter, MESSAGE_KEY_Count, 0), (time_t)last_sync);
      comm_transfer_end();
      wake_on_items_end();
      break;
    }
    case InSigninCode:
      comm_transfer_end();
      prv_handle_signin_code(iter);
      break;
    case InSigninResult:
      signin_win_on_result((int)prv_int_or(iter, MESSAGE_KEY_State, 2),
                           prv_str(iter, MESSAGE_KEY_Text));
      break;
    case InSchedule:
      model_set_schedule((int16_t)prv_int_or(iter, MESSAGE_KEY_SyncTime1, -1),
                         (int16_t)prv_int_or(iter, MESSAGE_KEY_SyncTime2, -1));
      wake_reschedule();
      break;
    case InResult:
      detail_win_on_result((int)prv_int_or(iter, MESSAGE_KEY_State, 1),
                           prv_str(iter, MESSAGE_KEY_Text));
      break;
    default:
      APP_LOG(APP_LOG_LEVEL_WARNING, "unknown command from phone");
      break;
  }
}

static void prv_inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "inbox dropped: %d", (int)reason);
}

void comm_init(void) {
  app_message_register_inbox_received(prv_inbox_received);
  app_message_register_inbox_dropped(prv_inbox_dropped);
  app_message_register_outbox_sent(prv_outbox_sent);
  app_message_register_outbox_failed(prv_outbox_failed);
  app_message_open(INBOX_SIZE, OUTBOX_SIZE);
  s_ready_timer = app_timer_register(JS_READY_WAIT_MS, prv_ready_timeout, NULL);
}

void comm_deinit(void) {
  if (s_retry_timer) {
    app_timer_cancel(s_retry_timer);
    s_retry_timer = NULL;
  }
  if (s_ready_timer) {
    app_timer_cancel(s_ready_timer);
    s_ready_timer = NULL;
  }
  comm_transfer_end();
  app_message_deregister_callbacks();
}
