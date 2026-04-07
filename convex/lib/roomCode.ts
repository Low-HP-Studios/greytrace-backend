const ROOM_CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomInt(max: number) {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0]! % max;
}

export function createRoomCode() {
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += ROOM_CODE_CHARSET[randomInt(ROOM_CODE_CHARSET.length)]!;
  }
  return code;
}
