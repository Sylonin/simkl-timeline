#pragma once
#include <pebble.h>

#include "model.h"

// Watch -> phone commands (contract Cmd values).
typedef enum {
  CmdHello = 1,
  CmdSync = 2,
  CmdSigninStart = 3,
  CmdSigninStop = 4,
  CmdMarkWatched = 5,
} OutCmd;

// HELLO Reason
#define HELLO_OPENED 0
#define HELLO_WAKEUP 1
#define HELLO_TIMELINE 2
// SYNC Reason
#define SYNC_OPEN 0
#define SYNC_MANUAL 1
#define SYNC_SCHEDULED 2

void comm_init(void);
void comm_deinit(void);

// Each returns false, and sets the "phone not connected" note, when the phone is away.
// Delivery failures after queueing are reported through comm_on_send_failed().
bool comm_send_hello(int reason);
bool comm_send_sync(int reason);
bool comm_send_signin_start(void);
void comm_send_signin_stop(void);
bool comm_send_mark_watched(const Item *item);

// Reduced Bluetooth sniff interval while a transfer is expected; always paired with
// comm_transfer_end() or the safety timeout.
void comm_transfer_begin(void);
void comm_transfer_end(void);
