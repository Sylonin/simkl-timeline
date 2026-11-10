#pragma once

// Rebuilds the launcher glance from the stored list: one slice per future item, each expiring
// when its item starts, so the glance always shows the next thing coming up. Call on exit.
// No-op on aplite, which has no App Glance.
void glance_update(void);
