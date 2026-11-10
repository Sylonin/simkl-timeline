#pragma once
#include <pebble.h>

#include "model.h"

// Cancels and re-creates the Wakeup events for the two sync times in the model. Called on every
// launch and whenever the phone sends a SCHEDULE.
void wake_reschedule(void);

// Wakeup received while the app is already open.
void wake_service_init(void);

// Launched by a Wakeup: shows a minimal syncing screen, asks the phone to sync and exits when
// that is done. Select hands over to the normal list.
void wake_start(void);

void wake_on_status(SyncState state);
void wake_on_items_end(void);
void wake_on_send_failed(uint8_t cmd);
