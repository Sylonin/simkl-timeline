#include "wake.h"

#include "comm.h"
#include "main_win.h"
#include "msg_win.h"

#define WAKE_TIMEOUT_MS 60000
// After the cached STATUS, the phone should start its sync within this long.
#define SYNC_START_GRACE_MS 10000
// After the final STATUS 0 the items follow straight away.
#define ITEMS_GRACE_MS 10000
// After an error STATUS nothing else is coming; leave a moment for stragglers.
#define ERROR_LINGER_MS 1000

#define RESCHEDULE_ATTEMPTS 5
#define MINUTES_IN_DAY 1440

static bool s_active;
static bool s_seen_syncing;
static AppTimer *s_timeout_timer;
static AppTimer *s_grace_timer;

static void prv_cancel_timers(void) {
  if (s_timeout_timer) {
    app_timer_cancel(s_timeout_timer);
    s_timeout_timer = NULL;
  }
  if (s_grace_timer) {
    app_timer_cancel(s_grace_timer);
    s_grace_timer = NULL;
  }
}

// Stale timer handles are never touched after this: the app is on its way out.
static void prv_exit(void *data) {
  s_active = false;
  window_stack_pop_all(false);
}

static void prv_exit_in(uint32_t ms) {
  if (s_grace_timer) {
    app_timer_cancel(s_grace_timer);
  }
  s_grace_timer = app_timer_register(ms, prv_exit, NULL);
}

static void prv_take_over(void) {
  prv_cancel_timers();
  s_active = false;
  main_win_push();
  msg_win_close_after(0);
}

void wake_start(void) {
  s_active = true;
  s_seen_syncing = false;
  msg_win_push("Syncing Simkl...", "Press Select to open", prv_take_over);
  if (!connection_service_peek_pebble_app_connection()) {
    prv_exit_in(0);
    return;
  }
  s_timeout_timer = app_timer_register(WAKE_TIMEOUT_MS, prv_exit, NULL);
  comm_send_hello(HELLO_WAKEUP);
}

void wake_on_status(SyncState state) {
  if (!s_active) {
    return;
  }
  if (state == StateSyncing) {
    s_seen_syncing = true;
    if (s_grace_timer) {
      app_timer_cancel(s_grace_timer);
      s_grace_timer = NULL;
    }
    return;
  }
  if (!s_seen_syncing) {
    // This is the cached status the phone sends first; wait for the real sync to start.
    if (!s_grace_timer) {
      s_grace_timer = app_timer_register(SYNC_START_GRACE_MS, prv_exit, NULL);
    }
    return;
  }
  prv_exit_in(state == StateReady ? ITEMS_GRACE_MS : ERROR_LINGER_MS);
}

void wake_on_items_end(void) {
  if (s_active && s_seen_syncing) {
    prv_exit_in(0);
  }
}

void wake_on_send_failed(uint8_t cmd) {
  if (s_active && cmd == CmdHello) {
    prv_exit_in(0);
  }
}

// Scheduling -----------------------------------------------------------------------------

static void prv_schedule(int16_t minute, int32_t cookie) {
  time_t when = clock_to_timestamp(TODAY, minute / 60, minute % 60);
  // Wakeups can't be set within 30 s of now; a minute of margin covers a wakeup that fired
  // slightly early.
  const time_t now = time(NULL);
  if (when < now + 60) {
    when += SECONDS_PER_DAY;
  }
  // E_RANGE means another event sits within a minute of this one, so nudge by a minute at a
  // time.
  for (int attempt = 0; attempt < RESCHEDULE_ATTEMPTS; attempt++) {
    const WakeupId id = wakeup_schedule(when + attempt * SECONDS_PER_MINUTE, cookie, false);
    if (id >= 0) {
      return;
    }
    if (id != E_RANGE) {
      APP_LOG(APP_LOG_LEVEL_ERROR, "wakeup_schedule failed: %d", (int)id);
      return;
    }
  }
  APP_LOG(APP_LOG_LEVEL_ERROR, "no free wakeup slot near %d", (int)minute);
}

void wake_reschedule(void) {
  wakeup_cancel_all();
  const int16_t first = model_sync_time(0);
  const int16_t second = model_sync_time(1);
  if (first >= 0 && first < MINUTES_IN_DAY) {
    prv_schedule(first, 1);
  }
  if (second >= 0 && second < MINUTES_IN_DAY && second != first) {
    prv_schedule(second, 2);
  }
}

static void prv_wakeup_while_open(WakeupId id, int32_t cookie) {
  if (!s_active && !model_syncing() && comm_send_sync(SYNC_SCHEDULED)) {
    model_set_syncing(true);
  }
  wake_reschedule();
}

void wake_service_init(void) {
  wakeup_service_subscribe(prv_wakeup_while_open);
}
