const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";

/** Firebase-compatible push id so existing UI keys keep working. */
export function pushId(now = Date.now()) {
  let ts = now;
  const time = new Array(8);
  for (let i = 7; i >= 0; i--) {
    time[i] = PUSH_CHARS.charAt(ts % 64);
    ts = Math.floor(ts / 64);
  }
  let rand = "";
  for (let i = 0; i < 12; i++) rand += PUSH_CHARS.charAt(Math.floor(Math.random() * 64));
  return time.join("") + rand;
}
