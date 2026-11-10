#include <pebble.h>

#include "comm.h"
#include "glance.h"
#include "main_win.h"
#include "model.h"
#include "ui.h"
#include "wake.h"

static void prv_init(void) {
  model_load();
  ui_init();
  comm_init();
  wake_reschedule();
  wake_service_init();

  switch (launch_reason()) {
    case APP_LAUNCH_WAKEUP:
      wake_start();
      break;
    case APP_LAUNCH_TIMELINE_ACTION:
      main_win_push();
      comm_send_hello(HELLO_TIMELINE);
      break;
    default:
      main_win_push();
      comm_send_hello(HELLO_OPENED);
      break;
  }
}

static void prv_deinit(void) {
  comm_deinit();
  glance_update();
  model_unload();
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
