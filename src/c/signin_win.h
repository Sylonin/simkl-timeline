#pragma once
#include <pebble.h>

// Opens the sign-in screen and asks the phone for a code (SIGNIN_START). Closing it sends
// SIGNIN_STOP while a code is still live.
void signin_win_push(void);

// SIGNIN_CODE: qr is NULL / qr_size 0 when the phone sent no usable QR; the code still shows.
void signin_win_on_code(const char *code, time_t expires, uint8_t qr_size, const uint8_t *qr,
                        uint16_t qr_len);
// SIGNIN_RESULT: 0 approved, 1 expired, 2 error.
void signin_win_on_result(int state, const char *text);
void signin_win_on_send_failed(uint8_t cmd);
